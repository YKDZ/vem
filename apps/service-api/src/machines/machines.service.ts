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
  auditLogs,
  count,
  desc,
  eq,
  gt,
  inArray,
  inventories,
  isNotNull,
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
  mediaAssets,
  machines,
  maintenancePeers,
  maintenanceSessions,
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
  isManagedMediaReference,
  machineHeartbeatStatusPayloadSchema,
  machineClaimRequestSchema,
  mqttSignedEnvelopeSchema,
  machineProvisioningProfileSchema,
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
import { MaintenanceAccessService } from "../maintenance-access/maintenance-access.service";
import { allocateTunnelAddress } from "../maintenance-access/maintenance-address-pools";
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
import {
  mapCreateMachineDtoToInsert,
  mapCreateMachineSlotDtoToInsert,
  mapEnvironmentControlDtoToCommandInsert,
  mapUpdateMachineDtoToPatch,
  toAdminMachineHeartbeatStatus,
  toAdminMachineCommandResponse,
  toAdminMachineResponse,
  toAdminMachineSlotResponse,
} from "./machines.contract-mappers";
import {
  calendarContextForLocalDate,
  type CalendarContext,
} from "./natural-context-calendar";
import {
  weatherConditionClassesFor,
  type WeatherConditionClass,
} from "./natural-context-weather";
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
    status: "ready" | "unconfigured";
    timezone: string;
    localDate?: string;
    localClock?: string;
  };
  weather?: {
    status: "ready" | "stale" | "unavailable" | "unconfigured";
    temperatureCelsius?: number;
    conditionText?: string;
    conditionCode?: string;
    observedAt?: string;
    windScale?: number;
    windSpeedKph?: number;
    weatherConditionClasses: WeatherConditionClass[];
    primaryWeatherConditionClass: WeatherConditionClass | null;
    diagnostic?: {
      reason: "machine_geo_location_missing" | "provider_unavailable";
      message: string;
    };
  };
  sun?: {
    status: "ready" | "stale" | "unavailable" | "unconfigured";
    sunriseAt?: string;
    sunsetAt?: string;
    diagnostic?: {
      reason: "machine_geo_location_missing" | "provider_unavailable";
      message: string;
    };
  };
  calendar?:
    | CalendarContext
    | {
        status: "unconfigured";
        festivals: [];
        primaryFestival: null;
        solarTerm: null;
        diagnostic: {
          reason: "machine_geo_timezone_missing";
          message: string;
        };
      };
  diagnostic?: {
    reason:
      | "machine_geo_location_missing"
      | "machine_geo_timezone_missing"
      | "provider_unavailable";
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
  claimResponseEncryptedJson: unknown;
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
const secureDecommissionResultSchema = z.strictObject({
  commandNo: z.string().min(1).max(64),
  success: z.boolean(),
  reportedAt: z.iso.datetime(),
  error: z.string().max(500).nullable(),
});
const secureDecommissionCommandPayloadSchema = z.strictObject({
  commandNo: z.string().min(1).max(64),
  operation: z.literal("secure-decommission"),
  requestedAt: z.iso.datetime(),
});

const SECURE_DECOMMISSION_ACK_TOPIC_SUFFIX =
  "/commands/secure-decommission-ack";

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
    tryOnSilhouetteUrl: slot.tryOnSilhouetteUrl ?? null,
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
    tryOnSilhouetteUrl: row.tryOnSilhouetteUrl ?? null,
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

function machineLocationAuditSnapshot(machine: MachineRecord) {
  return {
    locationLabel: machine.locationLabel,
    geoLocation: machineGeoLocationFromRow(machine),
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
      weather: {
        status: "unconfigured",
        weatherConditionClasses: [],
        primaryWeatherConditionClass: null,
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      },
      sun: {
        status: "unconfigured",
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      },
      calendar: {
        status: "unconfigured",
        festivals: [],
        primaryFestival: null,
        solarTerm: null,
        diagnostic: {
          reason: "machine_geo_timezone_missing",
          message: "Machine Geo Time Zone is not configured",
        },
      },
      diagnostic: {
        reason: "machine_geo_location_missing",
        message: "Machine Geo Location is not configured",
      },
    };
  }
  const localTime = formatLocalTime(now, geoLocation.timezone);
  const calendar = calendarContextForLocalDate(localTime.localDate);
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
  const input = { geoLocation, checkedAt: now };
  const [weatherResult, sunResult] = await Promise.allSettled([
    cachedWeather
      ? Promise.resolve(cachedWeather)
      : Promise.resolve(provider.fetchWeatherNow(input)).then((value) => {
          if (!value) {
            throw new Error(
              "External Natural Environment provider unavailable",
            );
          }
          cache?.weatherNow.set(cacheKey, {
            value,
            cachedAtMs: now.getTime(),
          });
          return value;
        }),
    cachedSun
      ? Promise.resolve(cachedSun)
      : Promise.resolve(provider.fetchSun(input)).then((value) => {
          if (!value) {
            throw new Error(
              "External Natural Environment provider unavailable",
            );
          }
          cache?.sun.set(sunCacheKey, {
            value,
            cachedAtMs: now.getTime(),
          });
          return value;
        }),
  ]);

  const weather =
    weatherResult.status === "fulfilled" ? weatherResult.value : null;
  const sun = sunResult.status === "fulfilled" ? sunResult.value : null;
  const staleWeather =
    weather ?? cache?.weatherNow.get(cacheKey)?.value ?? null;
  const staleSun = sun ?? cache?.sun.get(sunCacheKey)?.value ?? null;
  const weatherBlock = staleWeather
    ? weatherBlockFrom(
        weatherResult.status === "fulfilled" ? "ready" : "stale",
        staleWeather,
      )
    : {
        status: "unavailable" as const,
        weatherConditionClasses: [],
        primaryWeatherConditionClass: null,
        diagnostic: {
          reason: "provider_unavailable" as const,
          message: "External Natural Environment provider is unavailable",
        },
      };
  const sunBlock = staleSun
    ? {
        status:
          sunResult.status === "fulfilled"
            ? ("ready" as const)
            : ("stale" as const),
        sunriseAt: staleSun.sunriseAt,
        sunsetAt: staleSun.sunsetAt,
        ...(sunResult.status === "fulfilled"
          ? {}
          : {
              diagnostic: {
                reason: "provider_unavailable" as const,
                message: "External Natural Environment provider is unavailable",
              },
            }),
      }
    : {
        status: "unavailable" as const,
        diagnostic: {
          reason: "provider_unavailable" as const,
          message: "External Natural Environment provider is unavailable",
        },
      };
  const status =
    weatherBlock.status === "unavailable" || sunBlock.status === "unavailable"
      ? "unavailable"
      : weatherBlock.status === "stale" || sunBlock.status === "stale"
        ? "stale"
        : "ready";
  const diagnostic =
    status === "ready"
      ? undefined
      : {
          reason: "provider_unavailable" as const,
          message: "External Natural Environment provider is unavailable",
        };
  return {
    ...base,
    status,
    localTime,
    weather: weatherBlock,
    sun: sunBlock,
    calendar,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function weatherBlockFrom(
  status: "ready" | "stale",
  weather: ExternalNaturalEnvironmentWeather,
) {
  const classification = weatherConditionClassesFor(weather);
  return {
    status,
    temperatureCelsius: weather.temperatureCelsius,
    conditionText: weather.conditionText,
    observedAt: weather.observedAt,
    ...(weather.conditionCode === undefined
      ? {}
      : { conditionCode: weather.conditionCode }),
    ...(weather.windScale === undefined
      ? {}
      : { windScale: weather.windScale }),
    ...(weather.windSpeedKph === undefined
      ? {}
      : { windSpeedKph: weather.windSpeedKph }),
    ...classification,
    ...(status === "ready"
      ? {}
      : {
          diagnostic: {
            reason: "provider_unavailable" as const,
            message: "External Natural Environment provider is unavailable",
          },
        }),
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
    status: "ready" as const,
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
  private decommissionDeliveryInterval?: NodeJS.Timeout;
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
    @Inject(MaintenanceAccessService)
    private readonly maintenanceAccessService: MaintenanceAccessService,
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
    this.timeoutInterval.unref();
    this.decommissionDeliveryInterval = setInterval(() => {
      void this.deliverDueSecureDecommissionCommands().catch(
        (error: unknown) => {
          this.logger.warn(
            `deliverDueSecureDecommissionCommands failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
    }, 10_000);
    this.decommissionDeliveryInterval.unref();
  }

  onApplicationShutdown(): void {
    if (this.timeoutInterval) {
      clearInterval(this.timeoutInterval);
      this.timeoutInterval = undefined;
    }
    if (this.decommissionDeliveryInterval) {
      clearInterval(this.decommissionDeliveryInterval);
      this.decommissionDeliveryInterval = undefined;
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
          ...toAdminMachineResponse(machine),
          latestHeartbeatStatus: toAdminMachineHeartbeatStatus(
            latestHeartbeat?.statusPayload,
          ),
          latestHeartbeatReportedAt: latestHeartbeat?.reportedAt
            ? toIso(latestHeartbeat.reportedAt)
            : null,
          latestEnvironment: latestHeartbeat?.statusPayload.environment ?? null,
          reportedRuntimeConfiguration:
            latestHeartbeat?.statusPayload.reportedRuntimeConfiguration ?? null,
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
      .values(mapCreateMachineDtoToInsert(input))
      .returning();
    return toAdminMachineResponse(created);
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

    const updateValues = mapUpdateMachineDtoToPatch(input);

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
    return toAdminMachineResponse(updated);
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
      ...toAdminMachineResponse(machine),
      latestHeartbeatStatus: toAdminMachineHeartbeatStatus(
        latestHeartbeat?.statusPayload,
      ),
      latestHeartbeatReportedAt: latestHeartbeat?.reportedAt
        ? toIso(latestHeartbeat.reportedAt)
        : null,
      latestEnvironment: latestHeartbeat?.statusPayload.environment ?? null,
      reportedRuntimeConfiguration:
        latestHeartbeat?.statusPayload.reportedRuntimeConfiguration ?? null,
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

    return latestCommand ? toAdminMachineCommandResponse(latestCommand) : null;
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
    const now = new Date();
    const commandValues = mapEnvironmentControlDtoToCommandInsert({
      machineId: machine.id,
      adminUserId,
      commandNo,
      input: commandInput,
      timeoutSeconds,
      now,
    });

    const [created] = await this.db
      .insert(machineCommands)
      .values(commandValues)
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
      return toAdminMachineCommandResponse(sent);
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
      return toAdminMachineCommandResponse(failed);
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
    const canonicalSlots = await this.withCanonicalPlanogramCoverImages(
      planogram.slots,
    );

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
          canonicalSlots.map((slot) => planogramSlotValues(version.id, slot)),
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
        slotCount: canonicalSlots.length,
      },
    });

    return planogramVersionSnapshot(machine, created, canonicalSlots);
  }

  private async withCanonicalPlanogramCoverImages(
    slots: MachinePlanogramSlot[],
  ): Promise<MachinePlanogramSlot[]> {
    const variantIds = [...new Set(slots.map((slot) => slot.variantId))];
    if (variantIds.length === 0) return slots;

    const rows = await this.db
      .select({
        variantId: productVariants.id,
        productId: products.id,
        displayImagePublicUrl: sql<string | null>`(
          select ${mediaAssets.publicUrl}
          from ${mediaAssets}
          where ${mediaAssets.id} = ${products.displayImageMediaAssetId}
            and ${mediaAssets.purpose} = 'product_display_image'
            and ${mediaAssets.deletedAt} is null
          limit 1
        )`,
        tryOnSilhouettePublicUrl: sql<string | null>`(
          select ${mediaAssets.publicUrl}
          from ${mediaAssets}
          where ${mediaAssets.id} = ${productVariants.tryOnSilhouetteMediaAssetId}
            and ${mediaAssets.purpose} = 'try_on_silhouette'
            and ${mediaAssets.deletedAt} is null
          limit 1
        )`,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          inArray(productVariants.id, variantIds),
          isNull(productVariants.deletedAt),
          isNull(products.deletedAt),
        ),
      );
    const coverImageUrls = new Map(
      rows.map((row) => [
        row.productId,
        this.machineManagedMediaReference(row.displayImagePublicUrl),
      ]),
    );
    const tryOnSilhouetteUrls = new Map(
      rows.map((row) => [
        row.variantId,
        this.machineManagedMediaReference(row.tryOnSilhouettePublicUrl),
      ]),
    );

    return slots.map((slot) => ({
      ...slot,
      coverImageUrl: coverImageUrls.get(slot.productId) ?? null,
      tryOnSilhouetteUrl: tryOnSilhouetteUrls.get(slot.variantId) ?? null,
    }));
  }

  private planogramSlotSnapshotForMachine(
    row: typeof machinePlanogramSlots.$inferSelect,
  ): MachinePlanogramSlot {
    const snapshot = planogramSlotSnapshot(row);
    return {
      ...snapshot,
      coverImageUrl: this.machineManagedMediaReference(snapshot.coverImageUrl),
      tryOnSilhouetteUrl: this.machineManagedMediaReference(
        snapshot.tryOnSilhouetteUrl ?? null,
      ),
    };
  }

  private machineManagedMediaReference(
    publicUrl: string | null,
  ): string | null {
    if (!publicUrl) return null;
    if (isManagedMediaReference(publicUrl)) return publicUrl;
    try {
      const reference = new URL(publicUrl).pathname;
      if (isManagedMediaReference(reference)) return reference;
    } catch {
      // The warning below records the same safe failure as a non-URL value.
    }
    this.logger.warn(
      `catalog managed media reference rejected: ${publicUrl.slice(0, 256)}`,
    );
    return null;
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
      slots.map((slot) => this.planogramSlotSnapshotForMachine(slot)),
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

    const decommissionResultMatch =
      /^vem\/machines\/([^/]+)\/events\/secure-decommission-result$/.exec(
        topic,
      );
    if (decommissionResultMatch) {
      await this.handleSecureDecommissionResult(
        decommissionResultMatch[1],
        topic,
        payload,
      );
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
    const slots = await this.db
      .select()
      .from(machineSlots)
      .where(
        and(
          eq(machineSlots.machineId, machineId),
          isNull(machineSlots.deletedAt),
        ),
      )
      .orderBy(machineSlots.layerNo, machineSlots.cellNo);
    return slots.map(toAdminMachineSlotResponse);
  }

  async createSlot(machineId: string, input: CreateMachineSlotInput) {
    const slot = createMachineSlotSchema.parse(input);
    const [created] = await this.db
      .insert(machineSlots)
      .values(mapCreateMachineSlotDtoToInsert(machineId, slot))
      .returning();
    return toAdminMachineSlotResponse(created);
  }

  async getCatalogByMachineCode(code: string) {
    const rows = await this.db
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
        coverImageUrl: mediaAssets.publicUrl,
        tryOnSilhouetteUrl: sql<string | null>`(
          select ${mediaAssets.publicUrl}
          from ${mediaAssets}
          where ${mediaAssets.id} = ${productVariants.tryOnSilhouetteMediaAssetId}
            and ${mediaAssets.purpose} = 'try_on_silhouette'
            and ${mediaAssets.deletedAt} is null
          limit 1
        )`,
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
      .leftJoin(
        mediaAssets,
        and(
          eq(mediaAssets.id, products.displayImageMediaAssetId),
          isNull(mediaAssets.deletedAt),
        ),
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
    return rows.map((row) => ({
      ...row,
      coverImageUrl: this.machineManagedMediaReference(row.coverImageUrl),
      tryOnSilhouetteUrl: this.machineManagedMediaReference(
        row.tryOnSilhouetteUrl,
      ),
    }));
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
    const parsed = machineClaimRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException("Invalid machine claim request");
    }
    const claimRequest = parsed.data;
    if (
      claimRequest.provisioningProfile !==
      this.config.machineProvisioningProfile
    ) {
      throw new ConflictException(
        "Machine provisioning profile does not match service profile",
      );
    }
    const lookupDigest = digestMachineClaimCodeLookup(
      claimRequest.claimCode,
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
        claimResponseEncryptedJson:
          machineClaimCodes.claimResponseEncryptedJson,
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
    if (
      !verifyMachineClaimCode(claimRequest.claimCode, claimCode.verifierHash)
    ) {
      await this.recordFailedMachineClaim(claimCode, now);
      throw this.invalidMachineClaimCode();
    }
    const requestsMaintenanceRotation =
      claimRequest.maintenanceRotation === "rotate";
    if ((claimCode.purpose === "reclaim") !== requestsMaintenanceRotation) {
      throw new ConflictException(
        claimCode.purpose === "reclaim"
          ? "Machine reclaim requires maintenance identity rotation"
          : "Initial machine claim cannot rotate a maintenance identity",
      );
    }
    if (
      claimCode.state === "consumed" &&
      claimCode.claimResponseEncryptedJson &&
      claimCode.expiresAt.getTime() > now.getTime()
    ) {
      const replayProfile = this.parseMachineClaimReplay(
        claimCode.claimResponseEncryptedJson,
        claimRequest,
      );
      if (replayProfile) {
        await this.recordMachineClaimReplay(claimCode, now);
        return replayProfile;
      }
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
    const buildProfile = (
      claimCodeId: string,
      secretVersion: number,
      maintenance: {
        peer: { publicKey: string; tunnelAddress: string };
        relay: { publicKey: string; tunnelAddress: string };
        endpoint: string;
        reclaimExpiresAt: Date | null;
      },
    ): MachineProvisioningProfile => ({
      machine: {
        id: claimCode.machineId,
        code: claimCode.machineCode,
        name: claimCode.machineName,
        status: claimCode.machineStatus,
        locationLabel: claimCode.machineLocationLabel,
      },
      credentials: {
        machineSecret: bundle.machineSecret,
        machineSecretVersion: secretVersion,
        mqttSigningSecret: bundle.mqttSigningSecret,
        mqttConnection: {
          url: this.config.machineMqttUrl,
          clientId: mqttClientId,
          ...(this.config.mqttUsername
            ? { username: this.config.mqttUsername }
            : {}),
          ...(this.config.mqttPassword
            ? { password: this.config.mqttPassword }
            : {}),
        },
      },
      apiBaseUrl: this.config.machineApiBaseUrl,
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
      hardwareSlotTopology: {
        identity: "vem-prod-24",
        version: "2026-06-adr0026",
      },
      paymentCapability: {
        profile: "production",
        qrCodeEnabled: true,
        paymentCodeEnabled: true,
        serverTime: toIso(now),
      },
      provisioningProfile: claimRequest.provisioningProfile,
      maintenance: {
        publicKey: maintenance.peer.publicKey,
        tunnelAddress: maintenance.peer.tunnelAddress,
        address: `${maintenance.peer.tunnelAddress}/32`,
        endpoint: maintenance.endpoint,
        relay: {
          publicKey: maintenance.relay.publicKey,
          tunnelAddress: maintenance.relay.tunnelAddress,
          address: `${maintenance.relay.tunnelAddress}/32`,
        },
        roleRoutes: {
          relay: `${maintenance.relay.tunnelAddress}/32`,
          runner: this.config.maintenanceAddressPools.runner.cidr,
          maintainer: this.config.maintenanceAddressPools.maintainer.cidr,
        },
        ...(claimCode.purpose === "reclaim" && maintenance.reclaimExpiresAt
          ? { reclaimExpiresAt: maintenance.reclaimExpiresAt.toISOString() }
          : {}),
      },
      metadata: {
        profileVersion: 1,
        claimCodeId,
        claimedAt: toIso(now),
        serverTime: toIso(now),
      },
    });

    const claimResult = await this.db.transaction(async (tx) => {
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
        const [winner] = await tx
          .select({
            state: machineClaimCodes.state,
            expiresAt: machineClaimCodes.expiresAt,
            claimResponseEncryptedJson:
              machineClaimCodes.claimResponseEncryptedJson,
          })
          .from(machineClaimCodes)
          .where(
            and(
              eq(machineClaimCodes.id, claimCode.id),
              eq(machineClaimCodes.state, "consumed"),
              gt(machineClaimCodes.expiresAt, now),
            ),
          );
        const replayProfile = winner?.claimResponseEncryptedJson
          ? this.parseMachineClaimReplay(
              winner.claimResponseEncryptedJson,
              claimRequest,
            )
          : undefined;
        if (replayProfile) {
          await this.recordMachineClaimReplay(claimCode, now, tx);
          return { kind: "replayed" as const, profile: replayProfile };
        }
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
      const [relay] = await tx
        .select({
          publicKey: maintenancePeers.publicKey,
          tunnelAddress: maintenancePeers.tunnelAddress,
        })
        .from(maintenancePeers)
        .where(
          and(
            eq(maintenancePeers.id, this.config.maintenanceRelayPeerId),
            eq(maintenancePeers.role, "relay"),
            eq(maintenancePeers.status, "active"),
            isNull(maintenancePeers.revokedAt),
          ),
        );
      if (!relay) {
        throw new ConflictException("Maintenance relay peer is not configured");
      }
      if (relay.publicKey !== this.config.maintenanceRelayPublicKey) {
        throw new ConflictException(
          "Maintenance relay peer does not match service profile",
        );
      }
      if (relay.tunnelAddress !== this.config.maintenanceRelayTunnelAddress) {
        throw new ConflictException(
          "Maintenance relay peer does not match service profile",
        );
      }
      const endpoint = this.config.maintenanceRelayEndpoint;

      const [duplicatePublicKey] = await tx
        .select({ id: maintenancePeers.id })
        .from(maintenancePeers)
        .where(
          eq(maintenancePeers.publicKey, claimRequest.maintenancePublicKey),
        )
        .limit(1);
      if (duplicatePublicKey) {
        throw new ConflictException(
          "Maintenance peer public key already exists",
        );
      }

      const usedRows = await tx
        .select({ tunnelAddress: maintenancePeers.tunnelAddress })
        .from(maintenancePeers);
      const usedAddresses = new Set(usedRows.map((row) => row.tunnelAddress));
      const pool = this.config.maintenanceAddressPools.machine;
      const usableAddressCount = pool.lastHost - pool.firstHost + 1;
      let peer: { publicKey: string; tunnelAddress: string } | undefined;
      const reclaimExpiresAt =
        claimCode.purpose === "reclaim"
          ? new Date(
              now.getTime() +
                (this.config.machineReclaimHandshakeTimeoutSeconds ?? 300) *
                  1_000,
            )
          : null;
      // oxlint-disable no-await-in-loop -- allocation retries are serialized inside the claim transaction
      for (let attempt = 0; attempt < usableAddressCount; attempt += 1) {
        const tunnelAddress = allocateTunnelAddress(pool, usedAddresses);
        let created: { publicKey: string; tunnelAddress: string } | undefined;
        try {
          [created] = await tx
            .insert(maintenancePeers)
            .values({
              role: "machine",
              publicKey: claimRequest.maintenancePublicKey,
              tunnelAddress,
              machineId: claimCode.machineId,
              status:
                claimCode.purpose === "reclaim" ? "pending_reclaim" : "active",
              reclaimExpiresAt,
            })
            .onConflictDoNothing({ target: maintenancePeers.tunnelAddress })
            .returning({
              publicKey: maintenancePeers.publicKey,
              tunnelAddress: maintenancePeers.tunnelAddress,
            });
        } catch (error) {
          const constraint =
            error && typeof error === "object" && "constraint" in error
              ? (error as { constraint?: unknown }).constraint
              : undefined;
          if (constraint === "maintenance_peers_pending_machine_unique") {
            throw new ConflictException(
              "Machine reclaim handshake is already pending",
            );
          }
          throw error;
        }
        if (created) {
          peer = created;
          break;
        }
        usedAddresses.add(tunnelAddress);
      }
      // oxlint-enable no-await-in-loop
      if (!peer) {
        throw new ConflictException(
          "Machine maintenance address pool is exhausted",
        );
      }
      await this.maintenanceAccessService.projectDesiredStateAfterPeerMutation(
        tx,
        now,
      );
      const maintenance = { peer, relay, endpoint, reclaimExpiresAt };
      const profile = buildProfile(
        consumedClaimCode.id,
        rotatedMachine.secretVersion,
        maintenance,
      );
      await tx
        .update(machineClaimCodes)
        .set({
          claimResponseEncryptedJson:
            this.machineCredentialService.encryptClaimResponse(profile),
          updatedAt: now,
        })
        .where(eq(machineClaimCodes.id, consumedClaimCode.id));
      await this.auditService.record(
        {
          adminUserId: null,
          action:
            claimCode.purpose === "reclaim"
              ? "machines.claimCode.reclaim.consume"
              : "machines.claimCode.consume",
          resourceType: "machine",
          resourceId: claimCode.machineId,
          afterJson: {
            claimCodeId: consumedClaimCode.id,
            machineCode: claimCode.machineCode,
            ...(claimCode.purpose === "reclaim"
              ? { purpose: claimCode.purpose }
              : {}),
            state: "consumed",
            secretVersion: rotatedMachine.secretVersion,
            claimedAt: toIso(now),
            ...(claimCode.purpose === "reclaim"
              ? {
                  maintenancePeerState: "pending_reclaim",
                  reclaimExpiresAt: reclaimExpiresAt?.toISOString(),
                }
              : {}),
          },
        },
        tx,
      );
      return {
        kind: "consumed" as const,
        profile,
      };
    });
    return claimResult.profile;
  }

  private parseMachineClaimReplay(
    encrypted: unknown,
    request: MachineClaimRequest,
  ): MachineProvisioningProfile | undefined {
    try {
      const replay =
        this.machineCredentialService.decryptClaimResponse(encrypted);
      const profile = machineProvisioningProfileSchema.parse(replay);
      return profile.provisioningProfile === request.provisioningProfile &&
        profile.maintenance.publicKey === request.maintenancePublicKey
        ? profile
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async recordMachineClaimReplay(
    claimCode: Pick<
      MachineClaimCandidate,
      "id" | "machineId" | "machineCode" | "purpose"
    >,
    now: Date,
    executor?: Pick<DrizzleClient, "insert">,
  ): Promise<void> {
    const input = {
      adminUserId: null,
      action:
        claimCode.purpose === "reclaim"
          ? "machines.claimCode.reclaim.replay"
          : "machines.claimCode.replay",
      resourceType: "machine",
      resourceId: claimCode.machineId,
      afterJson: {
        claimCodeId: claimCode.id,
        machineCode: claimCode.machineCode,
        ...(claimCode.purpose === "reclaim"
          ? { purpose: claimCode.purpose }
          : {}),
        state: "consumed",
        replayedAt: toIso(now),
      },
    };
    if (executor) {
      await this.auditService.record(input, executor);
    } else {
      await this.auditService.record(input);
    }
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
        ...(expired ? { claimResponseEncryptedJson: null } : {}),
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

  async secureDecommissionMachine(id: string, adminUserId: string) {
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [machine] = await tx
        .select({
          id: machines.id,
          code: machines.code,
          status: machines.status,
          secretHash: machines.secretHash,
          credentialRevokedAt: machines.credentialRevokedAt,
          mqttSigningSecretEncryptedJson:
            machines.mqttSigningSecretEncryptedJson,
        })
        .from(machines)
        .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
        .for("update");
      if (!machine) throw new NotFoundException("Machine not found");
      if (machine.status === "disabled" && machine.credentialRevokedAt) {
        const [existingCommand] = await tx
          .select()
          .from(machineCommands)
          .where(
            and(
              eq(machineCommands.machineId, machine.id),
              eq(machineCommands.type, "secure-decommission"),
            ),
          )
          .orderBy(desc(machineCommands.createdAt))
          .limit(1);
        return { machine, command: existingCommand, alreadyRevoked: true };
      }

      const commandNo = createBusinessNo("DCOM");
      const commandPayload = {
        commandNo,
        operation: "secure-decommission" as const,
        requestedAt: now.toISOString(),
      };
      const deliveryPayload =
        machine.status === "online" && machine.mqttSigningSecretEncryptedJson
          ? this.mqttSignatureService.signSecureDecommissionCommandWithEncryptedCredential(
              machine.code,
              commandPayload,
              machine.mqttSigningSecretEncryptedJson,
            )
          : null;
      const deliveryExpiresAt = deliveryPayload
        ? new Date(
            Date.parse(deliveryPayload.issuedAt) +
              this.config.mqttSignatureToleranceSeconds * 1_000,
          )
        : null;
      const [command] = await tx
        .insert(machineCommands)
        .values({
          commandNo,
          machineId: machine.id,
          type: "secure-decommission",
          status: deliveryPayload ? "pending" : "succeeded",
          payloadJson: commandPayload,
          resultJson: deliveryPayload
            ? null
            : {
                success: true,
                state: "denied_on_reconnect",
                reportedAt: now.toISOString(),
              },
          resultAt: deliveryPayload ? null : now,
          requestedByAdminUserId: adminUserId,
          deliveryTopic: deliveryPayload
            ? `vem/machines/${machine.code}/commands/secure-decommission`
            : null,
          deliveryPayloadJson: deliveryPayload,
          nextDeliveryAttemptAt: deliveryPayload ? now : null,
          deliveryExpiresAt,
        })
        .returning();

      const peers = await tx
        .select({ id: maintenancePeers.id })
        .from(maintenancePeers)
        .where(
          and(
            eq(maintenancePeers.machineId, machine.id),
            inArray(maintenancePeers.status, [
              "active",
              "pending_reclaim",
              "reclaim_failed",
            ]),
            isNull(maintenancePeers.revokedAt),
          ),
        )
        .for("update");
      const peerIds = peers.map((peer) => peer.id);
      const revokedSessions = await tx
        .update(maintenanceSessions)
        .set({ revokedAt: now })
        .where(
          and(
            or(
              eq(maintenanceSessions.targetMachineId, machine.id),
              peerIds.length > 0
                ? inArray(maintenanceSessions.sourcePeerId, peerIds)
                : undefined,
            ),
            isNull(maintenanceSessions.revokedAt),
          ),
        )
        .returning({ id: maintenanceSessions.id });
      if (peerIds.length > 0) {
        await tx
          .update(maintenancePeers)
          .set({
            status: "revoked",
            revokedAt: now,
            reclaimExpiresAt: null,
            reclaimFailedAt: null,
            reclaimFailureReason: null,
            updatedAt: now,
          })
          .where(inArray(maintenancePeers.id, peerIds));
      }
      await tx
        .update(machineClaimCodes)
        .set({ state: "revoked", revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(machineClaimCodes.machineId, machine.id),
            inArray(machineClaimCodes.state, ["pending", "locked"]),
          ),
        );
      const [updated] = await tx
        .update(machines)
        .set({
          status: "disabled",
          secretHash: null,
          credentialRevokedAt: now,
          mqttClientId: null,
          mqttSigningSecretEncryptedJson:
            deliveryPayload === null
              ? null
              : machine.mqttSigningSecretEncryptedJson,
          updatedAt: now,
        })
        .where(eq(machines.id, machine.id))
        .returning({
          id: machines.id,
          code: machines.code,
          credentialRevokedAt: machines.credentialRevokedAt,
        });

      await this.maintenanceAccessService.projectDesiredStateAfterPeerMutation(
        tx,
        now,
      );
      await tx.insert(auditLogs).values([
        {
          adminUserId: adminUserId,
          action: "machines.secureDecommission",
          resourceType: "machine",
          resourceId: machine.id,
          beforeJson: {
            status: machine.status,
            credentialRevokedAt: machine.credentialRevokedAt,
            hadBusinessCredentials: Boolean(machine.secretHash),
            peerIds,
          },
          afterJson: {
            status: "disabled",
            credentialRevokedAt: now.toISOString(),
            revokedPeerIds: peerIds,
            revokedSessionIds: revokedSessions.map((session) => session.id),
            reconnectDenied: true,
            decommissionCommandId: command.id,
            localCleanupState: deliveryPayload
              ? "delivery_pending"
              : "denied_on_reconnect",
          },
        },
        ...peerIds.map((peerId) => ({
          adminUserId,
          action: "maintenanceAccess.peer.revoke",
          resourceType: "maintenance_peer",
          resourceId: peerId,
          afterJson: {
            reason: "secure_decommission",
            revokedAt: now.toISOString(),
          },
        })),
        ...revokedSessions.map((session) => ({
          adminUserId,
          action: "maintenanceAccess.session.revoke",
          resourceType: "maintenance_session",
          resourceId: session.id,
          afterJson: {
            reason: "secure_decommission",
            revokedAt: now.toISOString(),
          },
        })),
      ]);

      return {
        machine: { ...machine, ...updated },
        command,
        alreadyRevoked: false,
      };
    });

    let command = result.command;
    if (
      command?.deliveryPayloadJson &&
      (command.status !== "succeeded" || command.nextDeliveryAttemptAt)
    ) {
      command = await this.deliverSecureDecommissionCommand(command.id, now);
    }
    return {
      machineId: result.machine.id,
      machineCode: result.machine.code,
      decommissionedAt: toIso(result.machine.credentialRevokedAt ?? now),
      decommissionCommandId: command?.id ?? null,
      decommissionCommandStatus: command?.status ?? "succeeded",
      deliveryAttemptCount: command?.deliveryAttemptCount ?? 0,
      localTunnelRemoval:
        command?.status === "succeeded"
          ? command.deliveryPayloadJson
            ? "acknowledged"
            : "denied-on-reconnect"
          : "delivery-pending",
    };
  }

  async deliverDueSecureDecommissionCommands(
    now = new Date(),
  ): Promise<number> {
    const due = await this.db
      .select({ id: machineCommands.id })
      .from(machineCommands)
      .where(
        and(
          eq(machineCommands.type, "secure-decommission"),
          inArray(machineCommands.status, [
            "pending",
            "sent",
            "failed",
            "timeout",
            "succeeded",
          ]),
          isNotNull(machineCommands.deliveryPayloadJson),
          lte(machineCommands.nextDeliveryAttemptAt, now),
        ),
      );
    await Promise.all(
      due.map(async (command) => {
        await this.deliverSecureDecommissionCommand(command.id, now);
      }),
    );
    return due.length;
  }

  private async deliverSecureDecommissionCommand(
    commandId: string,
    now = new Date(),
  ) {
    const [command] = await this.db
      .select()
      .from(machineCommands)
      .where(
        and(
          eq(machineCommands.id, commandId),
          eq(machineCommands.type, "secure-decommission"),
        ),
      )
      .limit(1);
    if (!command) return command;
    if (!command.deliveryTopic || !command.deliveryPayloadJson) {
      return command;
    }
    const isCleanupAcknowledgement =
      command.status === "succeeded" &&
      command.deliveryTopic.endsWith(SECURE_DECOMMISSION_ACK_TOPIC_SUFFIX);
    if (isCleanupAcknowledgement) {
      try {
        await this.mqttService.publish(
          command.deliveryTopic,
          command.deliveryPayloadJson,
        );
        const [delivered] = await this.db
          .update(machineCommands)
          .set({
            deliveryAttemptCount: sql`${machineCommands.deliveryAttemptCount} + 1`,
            nextDeliveryAttemptAt: null,
            lastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(machineCommands.id, commandId),
              eq(machineCommands.status, "succeeded"),
              eq(machineCommands.deliveryTopic, command.deliveryTopic),
            ),
          )
          .returning();
        return delivered ?? command;
      } catch (error) {
        const [pending] = await this.db
          .update(machineCommands)
          .set({
            deliveryAttemptCount: sql`${machineCommands.deliveryAttemptCount} + 1`,
            nextDeliveryAttemptAt: new Date(now.getTime() + 10_000),
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: now,
          })
          .where(
            and(
              eq(machineCommands.id, commandId),
              eq(machineCommands.status, "succeeded"),
              eq(machineCommands.deliveryTopic, command.deliveryTopic),
            ),
          )
          .returning();
        return pending ?? command;
      }
    }
    if (command.status === "succeeded") return command;
    let deliveryPayload = mqttSignedEnvelopeSchema.parse(
      command.deliveryPayloadJson,
    );
    let deliveryExpiresAt = command.deliveryExpiresAt;
    if (!deliveryExpiresAt || deliveryExpiresAt <= now) {
      const [machine] = await this.db
        .select({
          code: machines.code,
          encryptedCredential: machines.mqttSigningSecretEncryptedJson,
        })
        .from(machines)
        .where(eq(machines.id, command.machineId))
        .limit(1);
      if (!machine?.encryptedCredential) {
        const [expired] = await this.db
          .update(machineCommands)
          .set({
            status: "timeout",
            resultAt: now,
            nextDeliveryAttemptAt: null,
            lastError: "secure decommission delivery credential is unavailable",
            updatedAt: now,
          })
          .where(eq(machineCommands.id, commandId))
          .returning();
        return expired;
      }
      deliveryPayload =
        this.mqttSignatureService.signSecureDecommissionCommandWithEncryptedCredential(
          machine.code,
          secureDecommissionCommandPayloadSchema.parse(command.payloadJson),
          machine.encryptedCredential,
        );
      deliveryExpiresAt = new Date(
        Date.parse(deliveryPayload.issuedAt) +
          this.config.mqttSignatureToleranceSeconds * 1_000,
      );
      await this.db
        .update(machineCommands)
        .set({
          deliveryPayloadJson: deliveryPayload,
          deliveryExpiresAt,
          status: "pending",
          resultAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(machineCommands.id, commandId));
    }
    try {
      await this.mqttService.publish(command.deliveryTopic, deliveryPayload);
      const [sent] = await this.db
        .update(machineCommands)
        .set({
          status: "sent",
          sentAt: command.sentAt ?? now,
          deliveryAttemptCount: sql`${machineCommands.deliveryAttemptCount} + 1`,
          nextDeliveryAttemptAt: new Date(now.getTime() + 10_000),
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(machineCommands.id, commandId),
            inArray(machineCommands.status, [
              "pending",
              "sent",
              "failed",
              "timeout",
            ]),
          ),
        )
        .returning();
      if (sent) return sent;
      return await this.getSecureDecommissionCommand(commandId);
    } catch (error) {
      const [pending] = await this.db
        .update(machineCommands)
        .set({
          status: "pending",
          deliveryAttemptCount: sql`${machineCommands.deliveryAttemptCount} + 1`,
          nextDeliveryAttemptAt: new Date(now.getTime() + 10_000),
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: now,
        })
        .where(
          and(
            eq(machineCommands.id, commandId),
            inArray(machineCommands.status, [
              "pending",
              "sent",
              "failed",
              "timeout",
            ]),
          ),
        )
        .returning();
      if (pending) return pending;
      return await this.getSecureDecommissionCommand(commandId);
    }
  }

  private async getSecureDecommissionCommand(commandId: string) {
    const [command] = await this.db
      .select()
      .from(machineCommands)
      .where(
        and(
          eq(machineCommands.id, commandId),
          eq(machineCommands.type, "secure-decommission"),
        ),
      )
      .limit(1);
    return command;
  }

  private async handleSecureDecommissionResult(
    machineCode: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    const rawPayload = this.parsePayload(payloadText);
    const unverifiedEnvelope = mqttSignedEnvelopeSchema.parse(rawPayload);
    const unverifiedResult = secureDecommissionResultSchema.parse(
      unverifiedEnvelope.payload,
    );
    const [record] = await this.db
      .select({
        commandId: machineCommands.id,
        commandNo: machineCommands.commandNo,
        commandStatus: machineCommands.status,
        deliveryTopic: machineCommands.deliveryTopic,
        deliveryPayloadJson: machineCommands.deliveryPayloadJson,
        nextDeliveryAttemptAt: machineCommands.nextDeliveryAttemptAt,
        machineId: machines.id,
        encryptedCredential: machines.mqttSigningSecretEncryptedJson,
      })
      .from(machineCommands)
      .innerJoin(machines, eq(machines.id, machineCommands.machineId))
      .where(
        and(
          eq(machines.code, machineCode),
          eq(machineCommands.commandNo, unverifiedResult.commandNo),
          eq(machineCommands.type, "secure-decommission"),
        ),
      )
      .limit(1);
    if (!record) return;
    if (record.commandStatus === "succeeded" && !record.encryptedCredential) {
      if (record.deliveryTopic && record.deliveryPayloadJson) {
        await this.db
          .update(machineCommands)
          .set({ nextDeliveryAttemptAt: new Date(), updatedAt: new Date() })
          .where(eq(machineCommands.id, record.commandId));
        await this.deliverSecureDecommissionCommand(record.commandId);
      }
      return;
    }
    const verified =
      this.mqttSignatureService.verifySecureDecommissionResultWithEncryptedCredential(
        {
          topicMachineCode: machineCode,
          rawPayload,
          payloadSchema: secureDecommissionResultSchema,
          encryptedCredential: record.encryptedCredential,
        },
      );
    if (
      verified.messageId !==
      `secure-decommission-result:${verified.payload.commandNo}`
    ) {
      throw new UnauthorizedException(
        "Secure decommission result message identity is invalid",
      );
    }

    const cleanupAcknowledgement =
      this.mqttSignatureService.signSecureDecommissionAcknowledgementWithEncryptedCredential(
        machineCode,
        {
          commandNo: verified.payload.commandNo,
          operation: "secure-decommission-ack",
          acknowledgedAt: new Date().toISOString(),
        },
        record.encryptedCredential,
      );

    let accepted = false;
    await this.db.transaction(async (tx) => {
      const [event] = await tx
        .insert(machineEvents)
        .values({
          machineId: record.machineId,
          eventType: "secure_decommission_result",
          payloadJson: verified.payload,
          mqttTopic: topic,
          messageId: verified.messageId,
        })
        .onConflictDoNothing()
        .returning({ id: machineEvents.id });
      if (!event) {
        const [existingEvent] = await tx
          .select({ payloadJson: machineEvents.payloadJson })
          .from(machineEvents)
          .where(
            and(
              eq(machineEvents.machineId, record.machineId),
              eq(machineEvents.messageId, verified.messageId),
            ),
          )
          .limit(1);
        const existingResult = secureDecommissionResultSchema.safeParse(
          existingEvent?.payloadJson,
        );
        if (
          !existingResult.success ||
          existingResult.data.success ||
          !verified.payload.success
        ) {
          return;
        }
      }
      accepted = true;
      const reportedAt = new Date(verified.payload.reportedAt);
      await tx
        .update(machineCommands)
        .set({
          status: verified.payload.success ? "succeeded" : "failed",
          resultJson: verified.payload,
          resultAt: reportedAt,
          nextDeliveryAttemptAt: verified.payload.success ? null : new Date(),
          ...(verified.payload.success
            ? {
                deliveryTopic: `vem/machines/${machineCode}/commands/secure-decommission-ack`,
                deliveryPayloadJson: cleanupAcknowledgement,
                nextDeliveryAttemptAt: new Date(),
                deliveryExpiresAt: null,
              }
            : {}),
          lastError: verified.payload.success
            ? null
            : (verified.payload.error ?? "local cleanup failed"),
          updatedAt: new Date(),
        })
        .where(eq(machineCommands.id, record.commandId));
      if (verified.payload.success) {
        await tx
          .update(machines)
          .set({
            mqttClientId: null,
            mqttSigningSecretEncryptedJson: null,
            updatedAt: new Date(),
          })
          .where(eq(machines.id, record.machineId));
      }
      await tx.insert(auditLogs).values({
        adminUserId: null,
        action: verified.payload.success
          ? "machines.secureDecommission.localCleanupAcknowledged"
          : "machines.secureDecommission.localCleanupFailed",
        resourceType: "machine",
        resourceId: record.machineId,
        afterJson: {
          commandNo: verified.payload.commandNo,
          success: verified.payload.success,
          reportedAt: verified.payload.reportedAt,
          error: verified.payload.error,
        },
      });
    });
    if (accepted && verified.payload.success) {
      await this.deliverSecureDecommissionCommand(record.commandId);
    }
  }

  async getOwnMaintenanceIdentity(machineId: string) {
    await this.maintenanceAccessService.sweepPendingReclaims();
    const identities = await this.db
      .select({
        publicKey: maintenancePeers.publicKey,
        status: maintenancePeers.status,
        reclaimExpiresAt: maintenancePeers.reclaimExpiresAt,
        handshakeVerifiedAt: maintenancePeers.handshakeVerifiedAt,
        reclaimFailedAt: maintenancePeers.reclaimFailedAt,
        reclaimFailureReason: maintenancePeers.reclaimFailureReason,
      })
      .from(maintenancePeers)
      .where(
        and(
          eq(maintenancePeers.machineId, machineId),
          inArray(maintenancePeers.status, [
            "active",
            "pending_reclaim",
            "reclaim_failed",
          ]),
          isNull(maintenancePeers.revokedAt),
        ),
      );
    return {
      machineId,
      identities: identities.map((identity) => ({
        ...identity,
        reclaimExpiresAt: identity.reclaimExpiresAt?.toISOString() ?? null,
        handshakeVerifiedAt:
          identity.handshakeVerifiedAt?.toISOString() ?? null,
        reclaimFailedAt: identity.reclaimFailedAt?.toISOString() ?? null,
      })),
    };
  }
}
