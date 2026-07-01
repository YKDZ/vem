import { z } from "zod";

import {
  machineClaimCodePurposeSchema,
  machineClaimCodeStateSchema,
  machineSlotStatusSchema,
  machineStatusSchema,
} from "../enums/machine";
import {
  addMachineSlotCoordinateIssue,
  machineSlotCellNoSchema,
  machineSlotLayerNoSchema,
} from "./machine-slot-coordinate";
import { machinePaymentOptionSchema } from "./orders";

function isIanaTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

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
  temperatureCelsius: z.number(),
  conditionText: z.string().min(1),
  observedAt: z.iso.datetime(),
});

const externalNaturalEnvironmentLocalTimeSchema = z.strictObject({
  timezone: z.string().refine(isIanaTimeZone, {
    message: "Timezone must be a valid IANA time zone",
  }),
  localDate: z.iso.date(),
  localClock: z.iso.time(),
});

const externalNaturalEnvironmentSunSchema = z.strictObject({
  sunriseAt: z.iso.datetime(),
  sunsetAt: z.iso.datetime(),
});

export const externalNaturalEnvironmentSchema = z.discriminatedUnion("status", [
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("ready"),
    localTime: externalNaturalEnvironmentLocalTimeSchema,
    weather: externalNaturalEnvironmentWeatherSchema,
    sun: externalNaturalEnvironmentSunSchema,
  }),
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("stale"),
    localTime: externalNaturalEnvironmentLocalTimeSchema,
    weather: externalNaturalEnvironmentWeatherSchema,
    sun: externalNaturalEnvironmentSunSchema,
    diagnostic: externalNaturalEnvironmentDiagnosticSchema,
  }),
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("unavailable"),
    diagnostic: externalNaturalEnvironmentDiagnosticSchema,
  }),
  externalNaturalEnvironmentBaseSchema.extend({
    status: z.literal("unconfigured"),
    diagnostic: externalNaturalEnvironmentDiagnosticSchema,
  }),
]);

const machineWriteShape = {
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  locationLabel: z.string().max(500).nullable().optional(),
  geoLocation: machineGeoLocationSchema.nullable().optional(),
  status: machineStatusSchema,
  mqttClientId: z.string().max(128).nullable().optional(),
};

export const createMachineSchema = z.strictObject({
  ...machineWriteShape,
  status: machineStatusSchema.default("offline"),
});

export const updateMachineSchema = z.strictObject(machineWriteShape).partial();

export const createMachineSlotSchema = z
  .object({
    layerNo: machineSlotLayerNoSchema,
    cellNo: machineSlotCellNoSchema,
    slotCode: z.string().min(1).max(32),
    capacity: z.int().min(0),
    status: machineSlotStatusSchema.default("enabled"),
  })
  .superRefine(addMachineSlotCoordinateIssue);

export const updateMachineSlotSchema = z
  .object({
    layerNo: machineSlotLayerNoSchema,
    cellNo: machineSlotCellNoSchema,
    slotCode: z.string().min(1).max(32),
    capacity: z.int().min(0),
    status: machineSlotStatusSchema.default("enabled"),
  })
  .partial()
  .superRefine(addMachineSlotCoordinateIssue);

export const machineEnvironmentHeartbeatPayloadSchema = z.object({
  temperatureCelsius: z.number().optional(),
  humidityRh: z.number().min(0).max(100).optional(),
  sampledAt: z.iso.datetime().optional(),
  sensorStatus: z.enum(["ok", "faulted", "unknown"]),
  airConditionerOn: z.boolean().optional(),
  targetTemperatureCelsius: z.number().nullable().optional(),
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
    saleReadiness: z
      .object({
        state: z.enum(["locked", "blocked", "restored"]),
        blockingCodes: z.array(z.string()).default([]),
      })
      .loose()
      .optional(),
    doorOpen: z.boolean().optional(),
    localQueueSize: z.int().nonnegative().optional(),
    lastCommandNo: z.string().max(64).nullable().optional(),
    environment: machineEnvironmentHeartbeatPayloadSchema.optional(),
  })
  .loose();

export const heartbeatPayloadSchema = z.object({
  machineCode: z.string().min(1).max(64),
  reportedAt: z.iso.datetime(),
  statusPayload: machineHeartbeatStatusPayloadSchema.default({}),
});

export const machineEnvironmentControlRequestSchema = z
  .object({
    airConditionerOn: z.boolean().optional(),
    targetTemperatureCelsius: z.number().min(18).max(30).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.airConditionerOn === undefined &&
      data.targetTemperatureCelsius === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "At least one of airConditionerOn or targetTemperatureCelsius is required",
      });
    }
  });

export type MachineHeartbeatStatusPayload = z.infer<
  typeof machineHeartbeatStatusPayloadSchema
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

const managedMediaAssetContentPathPattern =
  /^\/api\/media-assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/i;

const managedMediaAssetContentUrlSchema = z.string().refine(
  (value) => {
    if (!value.startsWith("/") && !/^https?:\/\//i.test(value)) return false;
    try {
      const url = new URL(value, "http://vem.local");
      return (
        managedMediaAssetContentPathPattern.test(url.pathname) &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  },
  {
    message:
      "coverImageUrl must point to a managed media asset content endpoint",
  },
);

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
  coverImageUrl: managedMediaAssetContentUrlSchema.nullable(),
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

export const generateMachineClaimCodeRequestSchema = z
  .strictObject({
    purpose: machineClaimCodePurposeSchema.default("first_claim"),
  })
  .default({ purpose: "first_claim" });

export const machineClaimRequestSchema = z.strictObject({
  claimCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)),
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

const legacyProductionMachinePaymentOptionSchema =
  machinePaymentOptionSchema.refine(
    (option) =>
      (option.providerCode === "wechat_pay" ||
        option.providerCode === "alipay") &&
      (option.method === "qr_code" || option.method === "payment_code"),
    {
      message:
        "Production machine payment capability can only include qr_code or payment_code real-provider methods",
    },
  );

const productionMachinePaymentCapabilityV1Schema = z.strictObject({
  profile: z.literal("production"),
  qrCodeEnabled: z.boolean().default(true),
  paymentCodeEnabled: z.boolean().default(true),
  serverTime: z.iso.datetime(),
});

const legacyProductionMachinePaymentCapabilitySchema = z
  .strictObject({
    profile: z.literal("production"),
    options: z.array(legacyProductionMachinePaymentOptionSchema),
    defaultOptionKey: z
      .string()
      .regex(/^(qr_code|payment_code):(wechat_pay|alipay)$/)
      .nullable(),
    defaultProviderCode: z.enum(["wechat_pay", "alipay"]).nullable(),
    serverTime: z.iso.datetime(),
  })
  .transform((capability) => ({
    profile: capability.profile,
    qrCodeEnabled: capability.options.some(
      (option) => option.method === "qr_code",
    ),
    paymentCodeEnabled: capability.options.some(
      (option) => option.method === "payment_code",
    ),
    serverTime: capability.serverTime,
  }));

export const productionMachinePaymentCapabilitySchema = z.union([
  productionMachinePaymentCapabilityV1Schema,
  legacyProductionMachinePaymentCapabilitySchema,
]);

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
  runtimeEndpoints: z.strictObject({
    apiBasePath: z.literal("/api"),
    machineAuthTokenPath: z.literal("/api/machine-auth/token"),
    machineApiBasePath: z.string().regex(/^\/api\/machines\/[^/]+$/),
    mqttTopicPrefix: z.string().regex(/^vem\/machines\/[^/]+$/),
  }),
  hardwareProfile: productionMachineHardwareProfileSchema,
  paymentCapability: productionMachinePaymentCapabilitySchema,
  metadata: z.strictObject({
    profileVersion: z.literal(1),
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
export type GenerateMachineClaimCodeRequest = z.infer<
  typeof generateMachineClaimCodeRequestSchema
>;
export type MachineClaimRequest = z.infer<typeof machineClaimRequestSchema>;
export type ProductionMachineHardwareProfile = z.infer<
  typeof productionMachineHardwareProfileSchema
>;
export type ProductionMachinePaymentCapability = z.infer<
  typeof productionMachinePaymentCapabilitySchema
>;
export type MachineProvisioningProfile = z.infer<
  typeof machineProvisioningProfileSchema
>;
