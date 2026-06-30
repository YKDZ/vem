import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
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
  lte,
  or,
  machineRawStockMovementConflicts,
  machineClaimCodes,
  machineRawStockMovements,
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
  createMachineSchema,
  createMachineSlotSchema,
  environmentControlResultPayloadSchema,
  machineHeartbeatStatusPayloadSchema,
  pageQuerySchema,
  machineEnvironmentControlRequestSchema,
  publishMachinePlanogramVersionSchema,
  updateMachineSchema,
  type CommandAckPayload,
  type EnvironmentControlResultPayload,
  type MachineEnvironmentControlRequest,
  type MachineHeartbeatStatusPayload,
  type MachineClaimRequest,
  type GenerateMachineClaimCodeRequest,
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
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import {
  EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER,
  UnconfiguredExternalNaturalEnvironmentProvider,
  type ExternalNaturalEnvironmentProvider,
  type ExternalNaturalEnvironmentSun,
  type ExternalNaturalEnvironmentWeather,
} from "./external-natural-environment.provider";
import {
  digestMachineClaimCodeLookup,
  generateHumanMachineClaimCode,
  hashMachineClaimCodeVerifier,
  verifyMachineClaimCode,
} from "./machine-claim-code.util";
import { evaluateProductionPilotReadiness } from "./production-pilot-readiness";

type PageQueryInput = z.infer<typeof pageQuerySchema>;
type CreateMachineInput = z.infer<typeof createMachineSchema>;
type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
type CreateMachineSlotInput = z.infer<typeof createMachineSlotSchema>;
type MachineGeoLocation = {
  latitude: number;
  longitude: number;
  timezone: string;
};
type ExternalNaturalEnvironment = {
  status: "ready" | "stale" | "unavailable" | "unconfigured";
  machineId: string;
  machineCode: string;
  checkedAt: string;
  localTime?: {
    timezone: string;
    localDate: string;
    localClock: string;
  };
  weather?: {
    temperatureCelsius: number;
    conditionText: string;
    observedAt: string;
  };
  sun?: {
    sunriseAt: string;
    sunsetAt: string;
  };
  diagnostic?: {
    reason: "machine_geo_location_missing" | "provider_unavailable";
    message: string;
  };
};
type CachedExternalNaturalEnvironmentValue<T> = {
  value: T;
  cachedAtMs: number;
};

type PlanogramVersionRecord = typeof machinePlanogramVersions.$inferSelect;

type MachineIdentity = {
  id: string;
  code: string;
};
type MachineRecord = typeof machines.$inferSelect;

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
  machineLocationLabel: string | null;
  machineStatus: MachineProvisioningProfile["machine"]["status"];
  machineMqttClientId: string | null;
  machineSecretVersion: number;
};

const MACHINE_CLAIM_CODE_MAX_FAILED_ATTEMPTS = 5;
const MACHINE_CLAIM_CODES_MACHINE_OPEN_UNIQUE =
  "machine_claim_codes_machine_open_unique";
const WEATHER_NOW_CACHE_TTL_MS = 10 * 60 * 1000;
const SUN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

function platformSlotSalesState(
  slotStatus: typeof machineSlots.$inferSelect.status,
  availableQty: number,
  openSaleSafetyBlockerState?: string | null,
) {
  if (openSaleSafetyBlockerState) {
    return openSaleSafetyBlockerState;
  }
  if (slotStatus !== "enabled") {
    return "frozen";
  }
  return availableQty > 0 ? "sale_ready" : "sold_out";
}

function parseLatestHeartbeatStatus(
  statusPayload: unknown,
): MachineHeartbeatStatusPayload | null {
  const parsed = machineHeartbeatStatusPayloadSchema.safeParse(statusPayload);
  return parsed.success ? parsed.data : null;
}

function machineGeoLocationFromRow(
  machine: Pick<MachineRecord, "geoLatitude" | "geoLongitude" | "geoTimezone">,
): MachineGeoLocation | null {
  if (
    machine.geoLatitude === null &&
    machine.geoLongitude === null &&
    machine.geoTimezone === null
  ) {
    return null;
  }
  if (
    typeof machine.geoLatitude !== "number" ||
    typeof machine.geoLongitude !== "number" ||
    typeof machine.geoTimezone !== "string"
  ) {
    return null;
  }
  return {
    latitude: machine.geoLatitude,
    longitude: machine.geoLongitude,
    timezone: machine.geoTimezone,
  };
}

function machineSnapshot<T extends MachineRecord>(machine: T) {
  const { geoLatitude, geoLongitude, geoTimezone, ...rest } = machine;
  return {
    ...rest,
    geoLocation: machineGeoLocationFromRow({
      geoLatitude,
      geoLongitude,
      geoTimezone,
    }),
  };
}

function machineLocationAuditSnapshot(machine: MachineRecord) {
  return {
    locationLabel: machine.locationLabel,
    geoLocation: machineGeoLocationFromRow(machine),
  };
}

function machineGeoLocationValues(
  geoLocation: MachineGeoLocation | null | undefined,
) {
  if (geoLocation === undefined) {
    return {};
  }
  return geoLocation === null
    ? { geoLatitude: null, geoLongitude: null, geoTimezone: null }
    : {
        geoLatitude: geoLocation.latitude,
        geoLongitude: geoLocation.longitude,
        geoTimezone: geoLocation.timezone,
      };
}

async function externalNaturalEnvironmentSnapshot(
  machine: MachineRecord,
  now: Date,
  provider: ExternalNaturalEnvironmentProvider,
  cache?: {
    weatherNow: Map<
      string,
      CachedExternalNaturalEnvironmentValue<ExternalNaturalEnvironmentWeather>
    >;
    sun: Map<
      string,
      CachedExternalNaturalEnvironmentValue<ExternalNaturalEnvironmentSun>
    >;
  },
): Promise<ExternalNaturalEnvironment> {
  const base = {
    machineId: machine.id,
    machineCode: machine.code,
    checkedAt: now.toISOString(),
  };
  const geoLocation = machineGeoLocationFromRow(machine);
  if (!geoLocation) {
    return {
      ...base,
      status: "unconfigured",
      diagnostic: {
        reason: "machine_geo_location_missing",
        message: "Machine Geo Location is not configured",
      },
    };
  }
  const cacheKey = machineGeoLocationCacheKey(geoLocation);
  const sunCacheKey = `${cacheKey}|${localDateYmd(now, geoLocation.timezone)}`;
  const cachedWeather = usableCachedValue(
    cache?.weatherNow.get(cacheKey),
    now,
    WEATHER_NOW_CACHE_TTL_MS,
  );
  const cachedSun = usableCachedValue(
    cache?.sun.get(sunCacheKey),
    now,
    SUN_CACHE_TTL_MS,
  );
  let weather: ExternalNaturalEnvironmentWeather | null = cachedWeather ?? null;
  let sun: ExternalNaturalEnvironmentSun | null = cachedSun ?? null;
  try {
    const input = { geoLocation, checkedAt: now };
    const [weatherResult, sunResult] = await Promise.all([
      weather
        ? Promise.resolve(weather)
        : provider.fetchWeatherNow(input).then((value) => {
            cache?.weatherNow.set(cacheKey, {
              value,
              cachedAtMs: now.getTime(),
            });
            return value;
          }),
      sun
        ? Promise.resolve(sun)
        : provider.fetchSun(input).then((value) => {
            cache?.sun.set(sunCacheKey, {
              value,
              cachedAtMs: now.getTime(),
            });
            return value;
          }),
    ]);
    weather = weatherResult;
    sun = sunResult;
  } catch {
    weather = cache?.weatherNow.get(cacheKey)?.value ?? null;
    sun = cache?.sun.get(sunCacheKey)?.value ?? null;
    if (weather && sun) {
      return {
        ...base,
        status: "stale",
        localTime: formatLocalTime(now, geoLocation.timezone),
        weather,
        sun,
        diagnostic: {
          reason: "provider_unavailable",
          message: "External Natural Environment provider is unavailable",
        },
      };
    }
  }
  if (!weather || !sun) {
    return {
      ...base,
      status: "unavailable",
      diagnostic: {
        reason: "provider_unavailable",
        message: "External Natural Environment provider is unavailable",
      },
    };
  }
  return {
    ...base,
    status: "ready",
    localTime: formatLocalTime(now, geoLocation.timezone),
    weather,
    sun,
  };
}

function machineGeoLocationCacheKey(geoLocation: MachineGeoLocation): string {
  return [
    geoLocation.latitude.toFixed(6),
    geoLocation.longitude.toFixed(6),
    geoLocation.timezone,
  ].join("|");
}

function usableCachedValue<T>(
  cached: CachedExternalNaturalEnvironmentValue<T> | undefined,
  now: Date,
  ttlMs: number,
): T | undefined {
  if (!cached || now.getTime() - cached.cachedAtMs >= ttlMs) {
    return undefined;
  }
  return cached.value;
}

function formatLocalTime(checkedAt: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(checkedAt);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    timezone,
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    localClock: `${part("hour")}:${part("minute")}:${part("second")}`,
  };
}

function localDateYmd(checkedAt: Date, timezone: string): string {
  return formatLocalTime(checkedAt, timezone).localDate.replaceAll("-", "");
}

@Injectable()
export class MachinesService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MachinesService.name);
  private timeoutInterval?: NodeJS.Timeout;
  private readonly externalNaturalEnvironmentCache = new Map<
    string,
    CachedExternalNaturalEnvironmentValue<ExternalNaturalEnvironmentWeather>
  >();
  private readonly externalNaturalEnvironmentSunCache = new Map<
    string,
    CachedExternalNaturalEnvironmentValue<ExternalNaturalEnvironmentSun>
  >();

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(MachineCredentialService)
    private readonly machineCredentialService: MachineCredentialService,
    @Inject(PaymentProviderConfigService)
    private readonly paymentProviderConfigService: PaymentProviderConfigService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
    @Inject(MqttService)
    private readonly mqttService: MqttService,
    @Inject(MqttSignatureService)
    private readonly mqttSignatureService: MqttSignatureService,
    @Inject(AppConfigService)
    private readonly config: AppConfigService,
    @Inject(NotificationsService)
    private readonly notificationsService: NotificationsService,
    @Optional()
    @Inject(EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER)
    private readonly externalNaturalEnvironmentProvider?: ExternalNaturalEnvironmentProvider,
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
      void this.markTimedOutMachineHeartbeats().catch((error: unknown) => {
        this.logger.warn(
          `markTimedOutMachineHeartbeats failed: ${
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

  private getExternalNaturalEnvironmentProvider(): ExternalNaturalEnvironmentProvider {
    return (
      this.externalNaturalEnvironmentProvider ??
      new UnconfiguredExternalNaturalEnvironmentProvider()
    );
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
      items.map(async (machine) => {
        const latestHeartbeat = await this.getLatestHeartbeatStatus(machine.id);
        return {
          ...machineSnapshot(machine),
          latestHeartbeatStatus: latestHeartbeat?.statusPayload ?? null,
          latestHeartbeatReportedAt: latestHeartbeat?.reportedAt ?? null,
          latestEnvironment: latestHeartbeat?.statusPayload.environment ?? null,
          latestEnvironmentCommand: await this.getLatestEnvironmentCommand(
            machine.id,
          ),
        };
      }),
    );

    return toPageResult(enrichedItems, query, Number(totalRow.total));
  }

  async createMachine(input: CreateMachineInput) {
    const [created] = await this.db
      .insert(machines)
      .values({
        code: input.code,
        name: input.name,
        locationLabel: input.locationLabel ?? null,
        ...machineGeoLocationValues(input.geoLocation),
        status: input.status,
        mqttClientId: input.mqttClientId ?? null,
      })
      .returning();
    return machineSnapshot(created);
  }

  async updateMachine(
    id: string,
    input: UpdateMachineInput,
    adminUserId: string,
  ) {
    const [current] = await this.db
      .select()
      .from(machines)
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
      .limit(1);

    if (!current) {
      throw new NotFoundException("Machine not found");
    }

    const updateValues: Partial<typeof machines.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.code !== undefined) updateValues.code = input.code;
    if (input.name !== undefined) updateValues.name = input.name;
    if (input.locationLabel !== undefined) {
      updateValues.locationLabel = input.locationLabel;
    }
    if ("geoLocation" in input) {
      Object.assign(updateValues, machineGeoLocationValues(input.geoLocation));
    }
    if (input.status !== undefined) updateValues.status = input.status;
    if (input.mqttClientId !== undefined) {
      updateValues.mqttClientId = input.mqttClientId;
    }

    const [updated] = await this.db
      .update(machines)
      .set(updateValues)
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Machine not found");
    }
    const beforeLocation = machineLocationAuditSnapshot(current);
    const afterLocation = machineLocationAuditSnapshot(updated);
    if (
      JSON.stringify(beforeLocation) !== JSON.stringify(afterLocation) &&
      ("locationLabel" in input || "geoLocation" in input)
    ) {
      await this.auditService.record({
        adminUserId,
        action: "machines.location.update",
        resourceType: "machine",
        resourceId: updated.id,
        beforeJson: beforeLocation,
        afterJson: afterLocation,
      });
    }
    return machineSnapshot(updated);
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

    const latestHeartbeat = await this.getLatestHeartbeatStatus(id);
    const [paymentEvidence, latestEnvironmentCommand] = await Promise.all([
      this.paymentProviderConfigService.listProductionPilotPaymentEvidenceForMachine(
        id,
      ),
      this.getLatestEnvironmentCommand(id),
    ]);
    const activeAcknowledgedPlanogramVersion =
      await this.getActiveAcknowledgedPlanogramVersion(id);
    return {
      ...machineSnapshot(machine),
      latestHeartbeatStatus: latestHeartbeat?.statusPayload ?? null,
      latestHeartbeatReportedAt: latestHeartbeat?.reportedAt ?? null,
      latestEnvironment: latestHeartbeat?.statusPayload.environment ?? null,
      latestEnvironmentCommand,
      productionPilotReadiness: evaluateProductionPilotReadiness({
        machine,
        latestHeartbeat,
        paymentOptions: paymentEvidence,
        machineHeartbeatTimeoutSeconds:
          this.config.machineHeartbeatTimeoutSeconds,
        platformPlanogram: {
          activeAcknowledgedPlanogramVersion,
        },
        externalNaturalEnvironment: {
          status: (
            await externalNaturalEnvironmentSnapshot(
              machine,
              new Date(),
              this.getExternalNaturalEnvironmentProvider(),
              this.externalNaturalEnvironmentCaches(),
            )
          ).status,
        },
      }),
    };
  }

  async getExternalNaturalEnvironmentForMachine(
    id: string,
    now = new Date(),
  ): Promise<ExternalNaturalEnvironment> {
    const [machine] = await this.db
      .select()
      .from(machines)
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    return externalNaturalEnvironmentSnapshot(
      machine,
      now,
      this.getExternalNaturalEnvironmentProvider(),
      this.externalNaturalEnvironmentCaches(),
    );
  }

  async getExternalNaturalEnvironmentForMachineCode(
    code: string,
    now = new Date(),
  ): Promise<ExternalNaturalEnvironment> {
    const [machine] = await this.db
      .select()
      .from(machines)
      .where(and(eq(machines.code, code), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    return externalNaturalEnvironmentSnapshot(
      machine,
      now,
      this.getExternalNaturalEnvironmentProvider(),
      this.externalNaturalEnvironmentCaches(),
    );
  }

  private externalNaturalEnvironmentCaches() {
    return {
      weatherNow: this.externalNaturalEnvironmentCache,
      sun: this.externalNaturalEnvironmentSunCache,
    };
  }

  private async getLatestHeartbeatStatus(machineId: string): Promise<{
    reportedAt: Date;
    statusPayload: MachineHeartbeatStatusPayload;
  } | null> {
    const [latestHeartbeat] = await this.db
      .select({
        reportedAt: machineHeartbeats.reportedAt,
        statusPayloadJson: machineHeartbeats.statusPayloadJson,
      })
      .from(machineHeartbeats)
      .where(eq(machineHeartbeats.machineId, machineId))
      .orderBy(desc(machineHeartbeats.reportedAt))
      .limit(1);

    const statusPayload = parseLatestHeartbeatStatus(
      latestHeartbeat?.statusPayloadJson,
    );
    return latestHeartbeat && statusPayload
      ? { reportedAt: latestHeartbeat.reportedAt, statusPayload }
      : null;
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

  private async getActiveAcknowledgedPlanogramVersion(
    machineId: string,
  ): Promise<string | null> {
    const [version] = await this.db
      .select({ planogramVersion: machinePlanogramVersions.planogramVersion })
      .from(machinePlanogramVersions)
      .where(
        and(
          eq(machinePlanogramVersions.machineId, machineId),
          eq(machinePlanogramVersions.status, "active"),
          sql`${machinePlanogramVersions.acknowledgedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(machinePlanogramVersions.activeAt))
      .limit(1);

    return version?.planogramVersion ?? null;
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
          inArray(machinePlanogramVersions.status, ["published", "active"]),
        ),
      )
      .orderBy(
        sql`case when ${machinePlanogramVersions.status} = 'published' then 0 else 1 end`,
        desc(machinePlanogramVersions.publishedAt),
      )
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

  async markTimedOutMachineHeartbeats(
    now = new Date(),
  ): Promise<{ processed: number }> {
    const timeoutSeconds = this.config.machineHeartbeatTimeoutSeconds;
    const staleBefore = new Date(now.getTime() - timeoutSeconds * 1_000);
    const candidates = await this.db
      .select({
        id: machines.id,
        code: machines.code,
        status: machines.status,
        lastSeenAt: machines.lastSeenAt,
      })
      .from(machines)
      .where(
        and(
          eq(machines.status, "online"),
          isNull(machines.deletedAt),
          or(
            isNull(machines.lastSeenAt),
            lte(machines.lastSeenAt, staleBefore),
          ),
        ),
      );

    const results = await Promise.all(
      candidates.map(async (machine) => {
        let updated = false;
        await this.db.transaction(async (tx) => {
          const [offline] = await tx
            .update(machines)
            .set({
              status: "offline",
              updatedAt: now,
            })
            .where(
              and(
                eq(machines.id, machine.id),
                eq(machines.status, "online"),
                or(
                  isNull(machines.lastSeenAt),
                  lte(machines.lastSeenAt, staleBefore),
                ),
              ),
            )
            .returning({ id: machines.id });
          if (!offline) {
            return;
          }
          updated = true;
          await this.notificationsService.createMachineOfflineNotification(tx, {
            machineId: machine.id,
            machineCode: machine.code,
            lastSeenAt: machine.lastSeenAt,
            timeoutSeconds,
            detectedAt: now,
          });
        });
        return updated;
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
    const slot = createMachineSlotSchema.parse(input);
    const [created] = await this.db
      .insert(machineSlots)
      .values({
        machineId,
        layerNo: slot.layerNo,
        cellNo: slot.cellNo,
        slotCode: slot.slotCode,
        capacity: slot.capacity,
        status: slot.status,
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

  async getStockSnapshotByMachineCode(code: string) {
    const rows = await this.db
      .select({
        machineCode: machines.code,
        planogramVersion: machinePlanogramVersions.planogramVersion,
        slotId: machinePlanogramSlots.slotId,
        slotCode: machinePlanogramSlots.slotCode,
        inventoryId: machinePlanogramSlots.inventoryId,
        capacity: machinePlanogramSlots.capacity,
        slotStatus: machineSlots.status,
        openSaleSafetyBlockerState: sql<string | null>`(
          select blocker_state
          from (
            select
              ${machineRawStockMovements.saleSafetyBlockerState} as blocker_state,
              ${machineRawStockMovements.receivedAt} as received_at
            from ${machineRawStockMovements}
            where ${machineRawStockMovements.machineId} = ${machines.id}
              and ${machineRawStockMovements.saleSafetyBlockerSlotId} = ${machinePlanogramSlots.slotId}
              and ${machineRawStockMovements.status} = 'reconciliation'
              and ${machineRawStockMovements.platformReviewStatus} = 'open'
              and ${machineRawStockMovements.saleSafetyBlockerState} is not null
            union all
            select
              ${machineRawStockMovementConflicts.saleSafetyBlockerState} as blocker_state,
              ${machineRawStockMovementConflicts.receivedAt} as received_at
            from ${machineRawStockMovementConflicts}
            where ${machineRawStockMovementConflicts.machineId} = ${machines.id}
              and ${machineRawStockMovementConflicts.saleSafetyBlockerSlotId} = ${machinePlanogramSlots.slotId}
              and ${machineRawStockMovementConflicts.status} = 'reconciliation'
              and ${machineRawStockMovementConflicts.platformReviewStatus} = 'open'
              and ${machineRawStockMovementConflicts.saleSafetyBlockerState} is not null
          ) open_blockers
          order by received_at desc
          limit 1
        )`,
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
        availableQty: sql<number>`case
          when ${machineSlots.status} = 'enabled'
            and not exists (
              select 1
              from ${machineRawStockMovements}
              where ${machineRawStockMovements.machineId} = ${machines.id}
                and ${machineRawStockMovements.saleSafetyBlockerSlotId} = ${machinePlanogramSlots.slotId}
                and ${machineRawStockMovements.status} = 'reconciliation'
                and ${machineRawStockMovements.platformReviewStatus} = 'open'
                and ${machineRawStockMovements.saleSafetyBlockerState} is not null
            )
            and not exists (
              select 1
              from ${machineRawStockMovementConflicts}
              where ${machineRawStockMovementConflicts.machineId} = ${machines.id}
                and ${machineRawStockMovementConflicts.saleSafetyBlockerSlotId} = ${machinePlanogramSlots.slotId}
                and ${machineRawStockMovementConflicts.status} = 'reconciliation'
                and ${machineRawStockMovementConflicts.platformReviewStatus} = 'open'
                and ${machineRawStockMovementConflicts.saleSafetyBlockerState} is not null
            )
          then ${inventories.onHandQty} - ${inventories.reservedQty}
          else 0
        end`,
      })
      .from(machines)
      .innerJoin(
        machinePlanogramVersions,
        and(
          eq(machinePlanogramVersions.machineId, machines.id),
          eq(machinePlanogramVersions.status, "active"),
          sql`${machinePlanogramVersions.acknowledgedAt} IS NOT NULL`,
        ),
      )
      .innerJoin(
        machinePlanogramSlots,
        eq(
          machinePlanogramSlots.machinePlanogramVersionId,
          machinePlanogramVersions.id,
        ),
      )
      .innerJoin(
        inventories,
        and(
          eq(inventories.id, machinePlanogramSlots.inventoryId),
          eq(inventories.machineId, machines.id),
          eq(inventories.slotId, machinePlanogramSlots.slotId),
        ),
      )
      .innerJoin(
        machineSlots,
        and(
          eq(machineSlots.id, machinePlanogramSlots.slotId),
          eq(machineSlots.machineId, machines.id),
          isNull(machineSlots.deletedAt),
        ),
      )
      .where(
        and(
          eq(machines.code, code),
          isNull(machines.deletedAt),
          inArray(machines.status, ["online", "maintenance"]),
        ),
      )
      .orderBy(machinePlanogramSlots.layerNo, machinePlanogramSlots.cellNo);

    const first = rows[0];
    if (!first) {
      throw new NotFoundException("Machine stock snapshot not found");
    }

    return {
      machineCode: first.machineCode,
      planogramVersion: first.planogramVersion,
      slots: rows.map((row) => ({
        slotId: row.slotId,
        slotCode: row.slotCode,
        inventoryId: row.inventoryId,
        capacity: row.capacity,
        onHandQty: row.onHandQty,
        reservedQty: row.reservedQty,
        availableQty: row.availableQty,
        slotSalesState: platformSlotSalesState(
          row.slotStatus,
          row.availableQty,
          row.openSaleSafetyBlockerState,
        ),
      })),
      serverTime: new Date().toISOString(),
    };
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
    if (
      input.purpose === "reclaim" &&
      !machine.secretHash &&
      machine.secretVersion <= 1
    ) {
      throw new ConflictException(
        "Machine has not been claimed; generate a first-claim code",
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
        machineLocationLabel: machines.locationLabel,
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
        locationLabel: claimCode.machineLocationLabel,
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
        qrCodeEnabled: true,
        paymentCodeEnabled: true,
        serverTime: toIso(now),
      },
      metadata: {
        profileVersion: 1,
        claimCodeId: consumed.id,
        claimedAt: toIso(now),
        serverTime: toIso(now),
      },
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
