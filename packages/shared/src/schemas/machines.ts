import { z } from "zod";

import {
  machineClaimCodePurposeSchema,
  machineClaimCodeStateSchema,
  machineCommandStatusSchema,
  machineSlotStatusSchema,
  machineStatusSchema,
} from "../enums/machine";
import {
  addMachineSlotCoordinateIssue,
  machineSlotCellNoSchema,
  machineSlotLayerNoSchema,
} from "./machine-slot-coordinate";
import {
  maintenanceWireGuardEndpointSchema,
  maintenanceWireGuardPublicKeySchema,
} from "./maintenance-access";

function isIanaTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

type ParsedIpv4Cidr = {
  network: number;
  broadcast: number;
  prefixLength: number;
};

const IPV4_CIDR_PATTERN =
  /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/;

function ipv4NumberToString(value: number): string {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join(".");
}

function parseCanonicalIpv4Cidr(
  value: string,
  minimumPrefixLength: number,
): ParsedIpv4Cidr | undefined {
  const match = IPV4_CIDR_PATTERN.exec(value);
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  const prefixLength = Number(match[5]);
  if (prefixLength < minimumPrefixLength) return undefined;
  const address =
    octets[0] * 2 ** 24 + octets[1] * 2 ** 16 + octets[2] * 2 ** 8 + octets[3];
  const blockSize = 2 ** (32 - prefixLength);
  const network = Math.floor(address / blockSize) * blockSize;
  if (`${ipv4NumberToString(network)}/${prefixLength}` !== value) {
    return undefined;
  }
  return { network, broadcast: network + blockSize - 1, prefixLength };
}

function ipv4CidrsOverlap(a: ParsedIpv4Cidr, b: ParsedIpv4Cidr): boolean {
  return a.network <= b.broadcast && b.network <= a.broadcast;
}

const maintenanceHostRouteSchema = z
  .string()
  .refine(
    (value) => parseCanonicalIpv4Cidr(value, 32)?.prefixLength === 32,
    "Maintenance address must be a valid canonical IPv4 /32",
  );

const maintenanceRoleRouteSchema = z
  .string()
  .refine(
    (value) => parseCanonicalIpv4Cidr(value, 24) !== undefined,
    "Maintenance role route must be a canonical IPv4 CIDR with prefix /24 or narrower",
  );

export const machineGeoLocationSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().refine(isIanaTimeZone, {
    message: "Timezone must be a valid IANA time zone",
  }),
});

export const externalNaturalEnvironmentStatusSchema = z.enum([
  "ready",
  "stale",
  "unavailable",
  "unconfigured",
]);

export const externalNaturalEnvironmentDiagnosticReasonSchema = z.enum([
  "machine_geo_location_missing",
  "machine_geo_timezone_missing",
  "provider_unavailable",
]);

const externalNaturalEnvironmentBaseSchema = z.strictObject({
  machineId: z.uuid(),
  machineCode: z.string().min(1).max(64),
  checkedAt: z.iso.datetime(),
});

const externalNaturalEnvironmentDiagnosticSchema = z.strictObject({
  reason: externalNaturalEnvironmentDiagnosticReasonSchema,
  message: z.string().min(1),
});

const externalNaturalEnvironmentWeatherSchema = z.strictObject({
  status: z.enum(["ready", "stale", "unavailable", "unconfigured"]),
  temperatureCelsius: z.number().optional(),
  conditionText: z.string().min(1).optional(),
  conditionCode: z.string().min(1).optional(),
  observedAt: z.iso.datetime().optional(),
  windScale: z.number().int().nonnegative().optional(),
  windSpeedKph: z.number().nonnegative().optional(),
  weatherConditionClasses: z.array(
    z.enum([
      "hail",
      "snow",
      "strong_wind",
      "moderate_or_heavy_rain",
      "light_rain",
      "other",
    ]),
  ),
  primaryWeatherConditionClass: z
    .enum([
      "hail",
      "snow",
      "strong_wind",
      "moderate_or_heavy_rain",
      "light_rain",
      "other",
    ])
    .nullable(),
  diagnostic: externalNaturalEnvironmentDiagnosticSchema.optional(),
});

const externalNaturalEnvironmentLocalTimeSchema = z.strictObject({
  status: z.enum(["ready", "unconfigured"]),
  timezone: z.string().refine(isIanaTimeZone, {
    message: "Timezone must be a valid IANA time zone",
  }),
  localDate: z.iso.date().optional(),
  localClock: z.iso.time().optional(),
});

const externalNaturalEnvironmentSunSchema = z.strictObject({
  status: z.enum(["ready", "stale", "unavailable", "unconfigured"]),
  sunriseAt: z.iso.datetime().optional(),
  sunsetAt: z.iso.datetime().optional(),
  diagnostic: externalNaturalEnvironmentDiagnosticSchema.optional(),
});

const festivalSchema = z.enum([
  "spring_festival",
  "new_years_day",
  "lantern_festival",
  "valentines_day",
  "qixi_festival",
  "labor_day",
  "dragon_boat_festival",
  "mid_autumn_festival",
  "national_day",
]);

const solarTermSchema = z.enum([
  "minor_cold",
  "major_cold",
  "start_of_spring",
  "rain_water",
  "awakening_of_insects",
  "spring_equinox",
  "clear_and_bright",
  "grain_rain",
  "start_of_summer",
  "grain_buds",
  "grain_in_ear",
  "summer_solstice",
  "minor_heat",
  "major_heat",
  "start_of_autumn",
  "end_of_heat",
  "white_dew",
  "autumn_equinox",
  "cold_dew",
  "frost_descent",
  "start_of_winter",
  "minor_snow",
  "major_snow",
  "winter_solstice",
]);

const externalNaturalEnvironmentCalendarSchema = z.strictObject({
  status: z.enum(["ready", "unconfigured"]),
  localDate: z.iso.date().optional(),
  festivals: z.array(festivalSchema),
  primaryFestival: festivalSchema.nullable(),
  solarTerm: solarTermSchema.nullable(),
  diagnostic: externalNaturalEnvironmentDiagnosticSchema.optional(),
});

export const externalNaturalEnvironmentSchema = z.discriminatedUnion("status", [
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("ready"),
    localTime: externalNaturalEnvironmentLocalTimeSchema,
    weather: externalNaturalEnvironmentWeatherSchema,
    sun: externalNaturalEnvironmentSunSchema,
    calendar: externalNaturalEnvironmentCalendarSchema,
  }),
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("stale"),
    localTime: externalNaturalEnvironmentLocalTimeSchema,
    weather: externalNaturalEnvironmentWeatherSchema,
    sun: externalNaturalEnvironmentSunSchema,
    calendar: externalNaturalEnvironmentCalendarSchema,
    diagnostic: externalNaturalEnvironmentDiagnosticSchema,
  }),
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("unavailable"),
    localTime: externalNaturalEnvironmentLocalTimeSchema.optional(),
    weather: externalNaturalEnvironmentWeatherSchema.optional(),
    sun: externalNaturalEnvironmentSunSchema.optional(),
    calendar: externalNaturalEnvironmentCalendarSchema.optional(),
    diagnostic: externalNaturalEnvironmentDiagnosticSchema,
  }),
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("unconfigured"),
    localTime: externalNaturalEnvironmentLocalTimeSchema.optional(),
    weather: externalNaturalEnvironmentWeatherSchema.optional(),
    sun: externalNaturalEnvironmentSunSchema.optional(),
    calendar: externalNaturalEnvironmentCalendarSchema.optional(),
    diagnostic: externalNaturalEnvironmentDiagnosticSchema,
  }),
]);

const machineCreateShape = {
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  locationLabel: z.string().max(500).nullable().optional(),
  geoLocation: machineGeoLocationSchema.nullable().optional(),
};

const machineWriteShape = {
  ...machineCreateShape,
  status: machineStatusSchema,
  mqttClientId: z.string().max(128).nullable().optional(),
};

export const createMachineSchema = z.strictObject(machineCreateShape);

export const updateMachineSchema = z.strictObject(machineWriteShape).partial();

export const createMachineSlotSchema = z
  .strictObject({
    layerNo: machineSlotLayerNoSchema,
    cellNo: machineSlotCellNoSchema,
    slotCode: z.string().min(1).max(32),
    capacity: z.int().min(0),
    status: machineSlotStatusSchema.default("enabled"),
  })
  .superRefine(addMachineSlotCoordinateIssue);

export const updateMachineSlotSchema = z
  .strictObject({
    layerNo: machineSlotLayerNoSchema,
    cellNo: machineSlotCellNoSchema,
    slotCode: z.string().min(1).max(32),
    capacity: z.int().min(0),
    status: machineSlotStatusSchema.default("enabled"),
  })
  .partial()
  .superRefine(addMachineSlotCoordinateIssue);

export const adminMachineSlotResponseSchema = z.strictObject({
  id: z.uuid(),
  machineId: z.uuid(),
  layerNo: machineSlotLayerNoSchema,
  cellNo: machineSlotCellNoSchema,
  slotCode: z.string().min(1).max(32),
  capacity: z.int().min(0),
  status: machineSlotStatusSchema,
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  deletedAt: z.iso.datetime().nullable().optional(),
});

export const machineEnvironmentHeartbeatPayloadSchema = z.object({
  temperatureCelsius: z.number().optional(),
  humidityRh: z.number().min(0).max(100).optional(),
  sampledAt: z.iso.datetime().optional(),
  sensorStatus: z.enum(["ok", "faulted", "unknown"]),
  airConditionerOn: z.boolean().optional(),
  targetTemperatureCelsius: z.number().nullable().optional(),
  ventSpeed: z.number().int().min(0).max(4).nullable().optional(),
});

export const machineReportedRuntimeConfigurationSchema = z.strictObject({
  audioCues: z
    .strictObject({
      enabled: z.boolean().nullable(),
      presenceEnabled: z.boolean().nullable(),
      transactionEnabled: z.boolean().nullable(),
    })
    .nullable(),
  audioVolume: z.number().int().min(0).max(100).nullable(),
  visionRecommendationsEnabled: z.boolean().nullable(),
});

export const machineHeartbeatStatusPayloadSchema = z
  .object({
    appVersion: z.string().optional(),
    os: z.string().optional(),
    network: z.enum(["online", "degraded", "offline"]).optional(),
    mqttConnected: z.boolean().optional(),
    hardwareAdapter: z.string().optional(),
    hardwareStatus: z.enum(["ok", "degraded", "faulted"]).optional(),
    hardwareMessage: z.string().optional(),
    hardwarePortPath: z.string().nullable().optional(),
    wholeMachineMaintenanceLock: z
      .object({
        code: z.string(),
        message: z.string(),
        source: z.string(),
        orderNo: z.string().optional(),
        commandNo: z.string().optional(),
        slotCode: z.string().optional(),
        errorCode: z.string().nullable().optional(),
        createdAt: z.iso.datetime().optional(),
      })
      .nullable()
      .optional(),
    doorOpen: z.boolean().optional(),
    localQueueSize: z.int().nonnegative().optional(),
    lastCommandNo: z.string().max(64).nullable().optional(),
    environment: machineEnvironmentHeartbeatPayloadSchema.optional(),
    reportedRuntimeConfiguration:
      machineReportedRuntimeConfigurationSchema.optional(),
  })
  .loose();

export const adminMachineHeartbeatStatusPayloadSchema = z.strictObject({
  appVersion: z.string().optional(),
  os: z.string().optional(),
  network: z.enum(["online", "degraded", "offline"]).optional(),
  mqttConnected: z.boolean().optional(),
  hardwareStatus: z.enum(["ok", "degraded", "faulted"]).optional(),
  wholeMachineMaintenanceLock: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      source: z.string(),
      orderNo: z.string().optional(),
      commandNo: z.string().optional(),
      slotCode: z.string().optional(),
      errorCode: z.string().nullable().optional(),
      createdAt: z.iso.datetime().optional(),
    })
    .nullable()
    .optional(),
  doorOpen: z.boolean().optional(),
  localQueueSize: z.int().nonnegative().optional(),
  lastCommandNo: z.string().max(64).nullable().optional(),
});

export const heartbeatPayloadSchema = z.object({
  machineCode: z.string().min(1).max(64),
  reportedAt: z.iso.datetime(),
  statusPayload: machineHeartbeatStatusPayloadSchema.default({}),
});

export const machineEnvironmentControlRequestSchema = z
  .strictObject({
    airConditionerOn: z.boolean().optional(),
    targetTemperatureCelsius: z.number().min(18).max(30).optional(),
    ventSpeed: z.number().int().min(0).max(4).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.airConditionerOn === undefined &&
      data.targetTemperatureCelsius === undefined &&
      data.ventSpeed === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "At least one of airConditionerOn, targetTemperatureCelsius or ventSpeed is required",
      });
    }
  });

export const adminMachineContractNoBodySchema = z.strictObject({});

export const adminMachineCommandResponseSchema = z.strictObject({
  id: z.uuid(),
  machineId: z.uuid(),
  commandNo: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  status: machineCommandStatusSchema,
  payloadJson: z.record(z.string(), z.unknown()).nullable().optional(),
  resultJson: z.record(z.string(), z.unknown()).nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
});

export const adminMachineRemoteOpResponseSchema = z.strictObject({
  id: z.uuid(),
  machineId: z.uuid().nullable(),
  type: z.string().min(1).max(64),
  status: z.string().min(1).max(32),
  requestedAt: z.iso.datetime(),
  requestedByAdminUserId: z.uuid().nullable(),
  acceptedAt: z.iso.datetime().nullable().optional(),
  finishedAt: z.iso.datetime().nullable().optional(),
  failedReason: z.string().nullable().optional(),
  resultJson: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const productionPilotReadinessStatusSchema = z.enum([
  "ready",
  "blocked",
  "degraded",
]);

export const productionPilotReadinessCheckStatusSchema = z.enum([
  "ready",
  "blocked",
  "degraded",
  "missing",
]);

const productionPilotReadinessCheckBaseSchema = z.strictObject({
  status: productionPilotReadinessCheckStatusSchema,
  reasonCode: z.string().min(1).max(96),
  actionCode: z.string().min(1).max(96),
});

const machineHeartbeatEvidenceSchema = z.strictObject({
  machineStatus: machineStatusSchema,
  heartbeatAgeSeconds: z.int().nonnegative().nullable(),
  timeoutSeconds: z.int().positive(),
  latestHeartbeatReportedAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});

const paymentReadinessEvidenceSchema = z.strictObject({
  productionProviderCount: z.int().nonnegative(),
});

const scannerRuntimeStatusEvidenceSchema = z.strictObject({
  scannerStatus: z.string().nullable(),
  scannerOnline: z.boolean().nullable(),
});

const naturalContextReadinessEvidenceSchema = z.strictObject({
  externalNaturalEnvironmentStatus: z.enum([
    "ready",
    "stale",
    "unavailable",
    "unconfigured",
  ]),
});

const productionDispensePathEvidenceSchema = z.strictObject({
  productionDispensePathStatus: z.string().nullable(),
});

const wholeMachineMaintenanceLockEvidenceSchema = z.strictObject({
  active: z.boolean(),
  lockCode: z.string().nullable(),
  slotCode: z.string().nullable(),
  commandNo: z.string().nullable(),
});

const physicalStockAttestationEvidenceSchema = z.strictObject({
  attestationStatus: z.string().nullable(),
  attestationPlanogramVersion: z.string().nullable(),
  activeAcknowledgedPlanogramVersion: z.string().nullable(),
  planogramMatches: z.boolean(),
});

const recoveryDrillEvidenceSchema = z.strictObject({
  recoveryDrillStatus: z.string().nullable(),
});

const managedMachineUpdateEvidenceSchema = z.strictObject({
  managedMachineUpdateStatus: z.string().nullable(),
});

export const productionPilotReadinessCheckSchema = z.discriminatedUnion(
  "kind",
  [
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("machine_heartbeat"),
      reasonCode: z.enum(["online", "stale", "missing"]),
      actionCode: z.enum(["continue_daily_inspection", "restore_connectivity"]),
      evidence: machineHeartbeatEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("payment_readiness"),
      reasonCode: z.enum(["ready", "no_production_provider"]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "enable_production_payment_provider",
      ]),
      evidence: paymentReadinessEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("scanner_runtime_status"),
      reasonCode: z.enum(["ready", "missing"]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "inspect_scanner_runtime",
      ]),
      evidence: scannerRuntimeStatusEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("natural_context_readiness"),
      reasonCode: z.enum(["ready", "stale", "unavailable", "unconfigured"]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "configure_machine_geo_location",
        "inspect_external_natural_environment",
      ]),
      evidence: naturalContextReadinessEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("production_dispense_path"),
      reasonCode: z.enum(["ready", "blocked"]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "restore_real_lower_controller_path",
      ]),
      evidence: productionDispensePathEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("whole_machine_maintenance_lock"),
      reasonCode: z.enum(["clear", "active"]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "clear_maintenance_lock_after_recovery",
      ]),
      evidence: wholeMachineMaintenanceLockEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("physical_stock_attestation"),
      reasonCode: z.enum([
        "ready",
        "missing",
        "stale",
        "inconsistent",
        "planogram_mismatch",
      ]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "record_physical_stock_attestation",
        "record_active_planogram_stock_attestation",
        "resolve_stock_state_inconsistencies",
        "apply_planogram_then_attest_stock",
      ]),
      evidence: physicalStockAttestationEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("recovery_drill"),
      reasonCode: z.enum(["ready", "missing"]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "complete_recovery_drills",
      ]),
      evidence: recoveryDrillEvidenceSchema,
    }),
    productionPilotReadinessCheckBaseSchema.extend({
      kind: z.literal("managed_machine_update"),
      reasonCode: z.enum(["ready", "missing"]),
      actionCode: z.enum([
        "continue_daily_inspection",
        "verify_managed_update_and_rollback",
      ]),
      evidence: managedMachineUpdateEvidenceSchema,
    }),
  ],
);

export const productionPilotReadinessDiagnosticContractSchema = z.strictObject({
  status: productionPilotReadinessStatusSchema,
  checkedAt: z.iso.datetime(),
  blockers: z.array(productionPilotReadinessCheckSchema),
  degraded: z.array(productionPilotReadinessCheckSchema),
  checks: z.array(productionPilotReadinessCheckSchema),
});

export const adminMachineResponseSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  locationLabel: z.string().max(500).nullable(),
  geoLocation: machineGeoLocationSchema.nullable(),
  status: machineStatusSchema,
  mqttClientId: z.string().max(128).nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  latestHeartbeatStatus: adminMachineHeartbeatStatusPayloadSchema
    .nullable()
    .optional(),
  latestHeartbeatReportedAt: z.iso.datetime().nullable().optional(),
  latestEnvironment: machineEnvironmentHeartbeatPayloadSchema
    .nullable()
    .optional(),
  reportedRuntimeConfiguration: machineReportedRuntimeConfigurationSchema
    .nullable()
    .optional(),
  latestEnvironmentCommand: adminMachineCommandResponseSchema
    .nullable()
    .optional(),
  productionPilotReadiness: productionPilotReadinessDiagnosticContractSchema
    .nullable()
    .optional(),
});

export const adminMachinePageResponseSchema = z.strictObject({
  items: z.array(adminMachineResponseSchema),
  total: z.int().nonnegative(),
  page: z.int().positive(),
  pageSize: z.int().positive(),
});

export const adminMachineOpsListQuerySchema = z.strictObject({
  machineId: z.uuid().optional(),
});

export const adminMachineRemoteOpListResponseSchema = z.array(
  adminMachineRemoteOpResponseSchema,
);

export type MachineHeartbeatStatusPayload = z.infer<
  typeof machineHeartbeatStatusPayloadSchema
>;
export type MachineReportedRuntimeConfiguration = z.infer<
  typeof machineReportedRuntimeConfigurationSchema
>;
export type AdminCreateMachineRequest = z.infer<typeof createMachineSchema>;
export type AdminUpdateMachineRequest = z.infer<typeof updateMachineSchema>;
export type AdminCreateMachineSlotRequest = z.infer<
  typeof createMachineSlotSchema
>;
export type AdminMachineResponse = z.infer<typeof adminMachineResponseSchema>;
export type AdminMachinePageResponse = z.infer<
  typeof adminMachinePageResponseSchema
>;
export type AdminMachineCommandResponse = z.infer<
  typeof adminMachineCommandResponseSchema
>;
export type ProductionPilotReadinessCheck = z.infer<
  typeof productionPilotReadinessCheckSchema
>;
export type ProductionPilotReadinessDiagnosticContract = z.infer<
  typeof productionPilotReadinessDiagnosticContractSchema
>;
export type AdminMachineRemoteOpResponse = z.infer<
  typeof adminMachineRemoteOpResponseSchema
>;
export type AdminMachineOpsListQuery = z.infer<
  typeof adminMachineOpsListQuerySchema
>;
export type AdminMachineSlotResponse = z.infer<
  typeof adminMachineSlotResponseSchema
>;
export type ExternalNaturalEnvironmentStatus = z.infer<
  typeof externalNaturalEnvironmentStatusSchema
>;
export type ExternalNaturalEnvironment = z.infer<
  typeof externalNaturalEnvironmentSchema
>;
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
export type MachineEnvironmentControlRequest = z.infer<
  typeof machineEnvironmentControlRequestSchema
>;

export const rawMachineStockMovementSchema = z.object({
  machineCode: z.string().min(1).max(64).optional(),
  movementId: z.string().min(1).max(128),
  planogramVersion: z.string().min(1).max(128),
  slotId: z.uuid(),
  movementType: z.enum([
    "planned_refill",
    "stock_count_correction",
    "dispense_succeeded",
  ]),
  quantity: z.int().nonnegative(),
  beforeQuantity: z.int().nonnegative().optional(),
  afterQuantity: z.int().nonnegative().optional(),
  slotMappingSnapshot: z
    .object({
      slotCode: z.string().min(1).max(32),
      capacity: z.int().nonnegative(),
      inventoryId: z.uuid().optional(),
      variantId: z.uuid().optional(),
    })
    .optional(),
  source: z.string().min(1).max(128),
  attributedTo: z.string().max(128).nullable().optional(),
  orderContext: z
    .object({
      orderNo: z.string().min(1).max(64),
      orderItemId: z.uuid(),
      vendingCommandNo: z.string().min(1).max(64),
      inventoryId: z.uuid(),
    })
    .optional(),
  occurredAt: z.iso.datetime(),
});

export type RawMachineStockMovement = z.infer<
  typeof rawMachineStockMovementSchema
>;

export const machineAuthTokenRequestSchema = z.object({
  machineCode: z.string().min(1).max(64),
  machineSecret: z.string().min(32).max(256),
});

export const machineAuthTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresInSeconds: z.int().positive(),
  machine: z.object({
    id: z.uuid(),
    code: z.string().min(1).max(64),
    status: machineStatusSchema,
  }),
});

export type MachineAuthTokenRequest = z.infer<
  typeof machineAuthTokenRequestSchema
>;
export type MachineAuthTokenResponse = z.infer<
  typeof machineAuthTokenResponseSchema
>;

export const managedMediaReferencePathPattern =
  /^\/api\/media-assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/i;

export function isManagedMediaReference(value: string): boolean {
  return managedMediaReferencePathPattern.test(value);
}

export const managedMediaReferenceSchema = z
  .string()
  .refine(isManagedMediaReference, {
    message: "media URL must point to a managed media asset content endpoint",
  });

const machineCatalogItemBaseSchema = z.object({
  machineCode: z.string().min(1).max(64),
  slotId: z.uuid(),
  slotCode: z.string().min(1).max(32),
  layerNo: machineSlotLayerNoSchema,
  cellNo: machineSlotCellNoSchema,
  inventoryId: z.uuid(),
  variantId: z.uuid(),
  productId: z.uuid(),
  productName: z.string().min(1).max(128),
  productDescription: z.string().nullable(),
  coverImageUrl: managedMediaReferenceSchema.nullable(),
  tryOnSilhouetteUrl: managedMediaReferenceSchema.nullable().optional(),
  categoryId: z.uuid().nullable(),
  categoryName: z.string().nullable(),
  sku: z.string().min(1).max(64),
  size: z.string().nullable(),
  color: z.string().nullable(),
  priceCents: z.int().nonnegative(),
  availableQty: z.int().nonnegative(),
  productSortOrder: z.int(),
  targetGender: z.enum(["male", "female"]).nullable().optional(),
});

export const machineCatalogItemSchema =
  machineCatalogItemBaseSchema.superRefine(addMachineSlotCoordinateIssue);

export type MachineCatalogItem = z.infer<typeof machineCatalogItemSchema>;

export const machinePlanogramVersionStatusSchema = z.enum([
  "published",
  "active",
  "retired",
]);

export const machinePlanogramSlotSchema = machineCatalogItemBaseSchema
  .omit({ machineCode: true, availableQty: true })
  .extend({
    capacity: z.int().nonnegative(),
    parLevel: z.int().nonnegative(),
  })
  .superRefine(addMachineSlotCoordinateIssue);

export const publishMachinePlanogramVersionSchema = z.object({
  planogramVersion: z.string().min(1).max(128),
  slots: z.array(machinePlanogramSlotSchema).min(1),
});

export const machinePlanogramVersionSnapshotSchema = z.object({
  machineId: z.uuid(),
  machineCode: z.string().min(1).max(64),
  planogramVersion: z.string().min(1).max(128),
  status: machinePlanogramVersionStatusSchema,
  publishedAt: z.iso.datetime(),
  acknowledgedAt: z.iso.datetime().nullable(),
  activeAt: z.iso.datetime().nullable(),
  slots: z.array(machinePlanogramSlotSchema),
});

export type MachinePlanogramVersionStatus = z.infer<
  typeof machinePlanogramVersionStatusSchema
>;
export type MachinePlanogramSlot = z.infer<typeof machinePlanogramSlotSchema>;
export type PublishMachinePlanogramVersion = z.infer<
  typeof publishMachinePlanogramVersionSchema
>;
export type MachinePlanogramVersionSnapshot = z.infer<
  typeof machinePlanogramVersionSnapshotSchema
>;

export const machineSaleViewItemSchema = machineCatalogItemBaseSchema
  .omit({ availableQty: true })
  .extend({
    capacity: z.int().nonnegative(),
    parLevel: z.int().nonnegative(),
    physicalStock: z.int().nonnegative(),
    saleableStock: z.int().nonnegative(),
    slotSalesState: z.enum([
      "sale_ready",
      "sold_out",
      "suspect",
      "frozen",
      "needs_count",
      "blocked_for_planogram_change",
      "movement_rejected",
      "needs_platform_review",
    ]),
  })
  .superRefine(addMachineSlotCoordinateIssue);

export const machineSaleViewSnapshotSchema = z.object({
  items: z.array(machineSaleViewItemSchema),
  source: z.string(),
  planogramVersion: z.string().nullable(),
  lastUpdatedAt: z.string().nullable(),
});

export type MachineSaleViewItem = z.infer<typeof machineSaleViewItemSchema>;
export type MachineSaleViewSnapshot = z.infer<
  typeof machineSaleViewSnapshotSchema
>;

export const machineClaimCodeSnapshotSchema = z.strictObject({
  id: z.uuid(),
  machineId: z.uuid(),
  machineCode: z.string().min(1).max(64),
  purpose: machineClaimCodePurposeSchema,
  state: machineClaimCodeStateSchema,
  expiresAt: z.iso.datetime(),
  failedAttemptCount: z.int().nonnegative(),
  maxFailedAttempts: z.int().positive(),
  createdAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable().optional(),
  revokedAt: z.iso.datetime().nullable().optional(),
  lockedAt: z.iso.datetime().nullable().optional(),
});

export const generateMachineClaimCodeResponseSchema =
  machineClaimCodeSnapshotSchema.extend({
    claimCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  });

export const machineClaimCodeListResponseSchema = z.strictObject({
  items: z.array(machineClaimCodeSnapshotSchema),
});

export const generateMachineClaimCodeRequestSchema = z
  .strictObject({
    purpose: machineClaimCodePurposeSchema.default("first_claim"),
  })
  .default({ purpose: "first_claim" });

export const rotateMachineCredentialsResponseSchema = z.strictObject({
  machineId: z.uuid(),
  machineCode: z.string().min(1).max(64),
  machineSecret: z.string().min(32).max(256),
  mqttSigningSecret: z.string().min(32).max(256),
  secretVersion: z.int().positive(),
});

export const machineClaimRequestSchema = z.strictObject({
  claimCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)),
});

export const machineProvisioningMaintenanceIdentitySchema = z
  .strictObject({
    publicKey: maintenanceWireGuardPublicKeySchema,
    tunnelAddress: z.ipv4(),
    address: maintenanceHostRouteSchema,
    endpoint: maintenanceWireGuardEndpointSchema,
    relay: z.strictObject({
      publicKey: maintenanceWireGuardPublicKeySchema,
      tunnelAddress: z.ipv4(),
      address: maintenanceHostRouteSchema,
    }),
    roleRoutes: z.strictObject({
      relay: maintenanceHostRouteSchema,
      runner: maintenanceRoleRouteSchema,
      maintainer: maintenanceRoleRouteSchema,
    }),
    reclaimExpiresAt: z.iso.datetime().optional(),
  })
  .superRefine((identity, ctx) => {
    if (identity.address !== `${identity.tunnelAddress}/32`) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "Maintenance address must match tunnelAddress as /32",
      });
    }
    if (identity.relay.address !== `${identity.relay.tunnelAddress}/32`) {
      ctx.addIssue({
        code: "custom",
        path: ["relay", "address"],
        message: "Maintenance relay address must match tunnelAddress as /32",
      });
    }
    if (identity.roleRoutes.relay !== identity.relay.address) {
      ctx.addIssue({
        code: "custom",
        path: ["roleRoutes", "relay"],
        message: "Maintenance relay route must match the relay /32 address",
      });
    }

    const machine = parseCanonicalIpv4Cidr(identity.address, 32);
    const relay = parseCanonicalIpv4Cidr(identity.relay.address, 32);
    const runner = parseCanonicalIpv4Cidr(identity.roleRoutes.runner, 24);
    const maintainer = parseCanonicalIpv4Cidr(
      identity.roleRoutes.maintainer,
      24,
    );
    if (!machine || !relay || !runner || !maintainer) return;
    if (
      ipv4CidrsOverlap(runner, maintainer) ||
      ipv4CidrsOverlap(runner, machine) ||
      ipv4CidrsOverlap(maintainer, machine) ||
      ipv4CidrsOverlap(runner, relay) ||
      ipv4CidrsOverlap(maintainer, relay)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["roleRoutes"],
        message:
          "Maintenance role routes must not overlap each other or peer addresses",
      });
    }
  });

export const productionMachineHardwareProfileSchema = z.strictObject({
  profile: z.literal("production"),
  controller: z.strictObject({
    required: z.literal(true),
    protocol: z.literal("vem-vending-controller"),
  }),
  paymentScanner: z.strictObject({
    required: z.literal(true),
    supportsPaymentCode: z.boolean(),
  }),
  vision: z.strictObject({
    required: z.boolean(),
    supportsRecommendations: z.boolean(),
  }),
});

export const hardwareSlotTopologyIdentitySchema = z.strictObject({
  identity: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
});

export const productionMachinePaymentCapabilitySchema = z.strictObject({
  profile: z.literal("production"),
  qrCodeEnabled: z.boolean().default(true),
  paymentCodeEnabled: z.boolean().default(true),
  serverTime: z.iso.datetime(),
});

export const machineProvisioningProfileSchema = z.strictObject({
  machine: z.strictObject({
    id: z.uuid(),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    status: machineStatusSchema,
    locationLabel: z.string().nullable(),
  }),
  credentials: z.strictObject({
    machineSecret: z.string().min(32).max(256),
    machineSecretVersion: z.int().positive(),
    mqttSigningSecret: z.string().min(32).max(256),
    mqttConnection: z.strictObject({
      url: z.url(),
      clientId: z.string().min(1).max(128),
      username: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
    }),
  }),
  apiBaseUrl: z.url(),
  runtimeEndpoints: z.strictObject({
    apiBasePath: z.literal("/api"),
    machineAuthTokenPath: z.literal("/api/machine-auth/token"),
    machineApiBasePath: z.string().regex(/^\/api\/machines\/[^/]+$/),
    mqttTopicPrefix: z.string().regex(/^vem\/machines\/[^/]+$/),
  }),
  hardwareProfile: productionMachineHardwareProfileSchema,
  hardwareModel: z.string().min(1).max(128),
  hardwareSlotTopology: hardwareSlotTopologyIdentitySchema,
  paymentCapability: productionMachinePaymentCapabilitySchema,
  metadata: z.strictObject({
    profileVersion: z.literal(1),
    profileRevision: z.int().positive(),
    claimCodeId: z.uuid(),
    claimedAt: z.iso.datetime(),
    serverTime: z.iso.datetime(),
  }),
});

export type MachineClaimCodeSnapshot = z.infer<
  typeof machineClaimCodeSnapshotSchema
>;
export type GenerateMachineClaimCodeResponse = z.infer<
  typeof generateMachineClaimCodeResponseSchema
>;
export type MachineClaimCodeListResponse = z.infer<
  typeof machineClaimCodeListResponseSchema
>;
export type GenerateMachineClaimCodeRequest = z.infer<
  typeof generateMachineClaimCodeRequestSchema
>;
export type RotateMachineCredentialsResponse = z.infer<
  typeof rotateMachineCredentialsResponseSchema
>;
export type MachineClaimRequest = z.infer<typeof machineClaimRequestSchema>;
export type MachineProvisioningMaintenanceIdentity = z.infer<
  typeof machineProvisioningMaintenanceIdentitySchema
>;
export type ProductionMachineHardwareProfile = z.infer<
  typeof productionMachineHardwareProfileSchema
>;
export type HardwareSlotTopologyIdentity = z.infer<
  typeof hardwareSlotTopologyIdentitySchema
>;
export type ProductionMachinePaymentCapability = z.infer<
  typeof productionMachinePaymentCapabilitySchema
>;
export type MachineProvisioningProfile = z.infer<
  typeof machineProvisioningProfileSchema
>;
