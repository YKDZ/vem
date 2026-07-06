import {
  environmentControlResultPayloadSchema,
  machineCatalogItemSchema,
  machineOrderStatusNextActionSchema,
  machinePaymentOptionsResponseSchema,
  machinePaymentProviderCodeSchema,
  machineSaleViewSnapshotSchema,
  orderStatusSchema,
  paymentCodeAttemptStatusSchema,
  paymentCodeSourceSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  vendingCommandStatusSchema,
} from "@vem/shared";
import { z } from "zod";

const usbIdentitySchema = z.object({
  vendorId: z.string(),
  productId: z.string(),
  serialNumber: z.string().nullable().default(null),
});

const audioCueSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  categories: z
    .object({
      presence: z.boolean().default(false),
      transaction: z.boolean().default(false),
    })
    .default({
      presence: false,
      transaction: false,
    }),
});

const configSummaryPublicSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    const publicConfig: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(value)),
    };
    if (
      !("audioCueSettings" in publicConfig) &&
      typeof publicConfig.presenceAudioEnabled === "boolean"
    ) {
      publicConfig.audioCueSettings = {
        enabled: publicConfig.presenceAudioEnabled,
        categories: {
          presence: publicConfig.presenceAudioEnabled,
          transaction: false,
        },
      };
    }
    delete publicConfig.presenceAudioEnabled;
    return publicConfig;
  },
  z.object({
    machineCode: z.string().nullable(),
    machineLocationLabel: z.string().nullable().optional(),
    apiBaseUrl: z.string(),
    mqttUrl: z.string(),
    mqttUsername: z.string().nullable(),
    hardwareAdapter: z.enum(["mock", "serial"]),
    serialPortPath: z.string().nullable(),
    lowerControllerUsbIdentity: usbIdentitySchema.nullable().optional(),
    scannerAdapter: z.enum(["disabled", "serial_text"]),
    scannerSerialPortPath: z.string().nullable(),
    scannerUsbIdentity: usbIdentitySchema.nullable().optional(),
    scannerBaudRate: z.number().int(),
    scannerFrameSuffix: z.enum(["crlf", "lf", "cr", "none"]),
    visionEnabled: z.boolean(),
    visionWsUrl: z.string(),
    visionRequestTimeoutMs: z.number().int(),
    machineAudioVolume: z.number().min(0).max(1).default(0.7),
    audioCueSettings: audioCueSettingsSchema.default({
      enabled: false,
      categories: {
        presence: false,
        transaction: false,
      },
    }),
    kioskMode: z.boolean(),
    stockMovementRetentionDays: z.number().int().min(1).max(366).default(30),
  }),
);

const lowerControllerCandidateSchema = z.object({
  portPath: z.string(),
  usbIdentity: usbIdentitySchema.nullable().optional(),
  handshake: z.string().nullable().optional(),
});

const componentHealthSchema = z.object({
  component: z.string(),
  level: z.string(),
  code: z.string(),
  message: z.string(),
  updatedAt: z.string(),
});

export const readyReasonSchema = z.object({
  code: z.string(),
  component: z.string(),
  message: z.string(),
});

export const healthSnapshotSchema = z.object({
  status: z.enum(["healthy", "degraded", "offline", "maintenance", "starting"]),
  process: componentHealthSchema,
  components: z.array(componentHealthSchema),
  configConfigured: z.boolean(),
  databaseOnline: z.boolean(),
  backendOnline: z.boolean(),
  mqttConnected: z.boolean(),
  outboxSize: z.number().int().nonnegative(),
  outboxMax: z.number().int().positive(),
  hardwareOnline: z.boolean(),
  scannerOnline: z.boolean(),
  visionOnline: z.boolean(),
  remoteOpsActive: z.boolean(),
  currentTransaction: z
    .object({
      orderNo: z.string(),
      status: z.string(),
      nextAction: z.string(),
      updatedAt: z.string(),
    })
    .nullable(),
  operatorReason: z.string(),
  updatedAt: z.string(),
});

export const readySnapshotSchema = z.object({
  ready: z.boolean(),
  canSell: z.boolean(),
  mode: z.string(),
  blockingCodes: z.array(z.string()),
  blockingReasons: z.array(readyReasonSchema),
  degradedReasons: z.array(readyReasonSchema),
  suggestedRoute: z.enum([
    "maintenance",
    "offline",
    "catalog",
    "payment",
    "dispensing",
    "result",
  ]),
  updatedAt: z.string(),
});

export const configSummarySchema = z.object({
  public: configSummaryPublicSchema,
  machineSecretConfigured: z.boolean(),
  mqttSigningSecretConfigured: z.boolean(),
  mqttPasswordConfigured: z.boolean(),
  provisioned: z.boolean().default(false),
  provisioningIssues: z.array(z.string()).default([]),
});

const bringUpReasonSchema = z.object({
  code: z.string(),
  component: z.string(),
  message: z.string(),
});

export const bringUpSnapshotSchema = z.object({
  state: z.enum([
    "network_required",
    "platform_reachable",
    "claim_required",
    "profile_applied",
    "topology_mismatch",
    "hardware_acceptance_required",
    "stock_attestation_required",
    "runtime_ready",
    "simulated_hardware_ready",
    "sell_ready",
  ]),
  blockingReasons: z.array(bringUpReasonSchema),
  diagnostics: z.array(bringUpReasonSchema),
  readinessLevel: z.enum([
    "not_ready",
    "runtime_ready",
    "simulated_hardware_ready",
    "sell_ready",
  ]),
  hardwareMode: z.enum(["production", "simulated"]),
  allowedActions: z.object({
    configureNetwork: z.boolean(),
    claimMachine: z.boolean(),
    retryClaim: z.boolean(),
    syncProfile: z.boolean(),
    resolveTopology: z.boolean(),
    runRuntimeAcceptance: z.boolean(),
    runHardwareAcceptance: z.boolean(),
    attestStock: z.boolean(),
    startSales: z.boolean(),
  }),
  updatedAt: z.string(),
});

const networkDiagnosticSchema = z.object({
  component: z.string(),
  level: z.string(),
  code: z.string(),
  message: z.string(),
});

export const networkSettingsResponseSchema = z.object({
  status: z.enum(["connected", "failed", "unsupported"]),
  ssid: z.string(),
  hidden: z.boolean(),
  diagnostics: z.array(networkDiagnosticSchema),
  operatorGuidance: z.string(),
  updatedAt: z.string(),
});

export const provisioningClaimResponseSchema = z.object({
  status: z.literal("provisioned"),
  machineCode: z.string(),
  restartRequested: z.boolean(),
  config: configSummarySchema,
});

export const transactionSnapshotSchema = z
  .object({
    orderId: z.string().nullable(),
    orderNo: z.string().nullable(),
    productSummary: z.unknown().nullable(),
    paymentNo: z.string().nullable(),
    paymentMethod: paymentMethodSchema.nullable(),
    paymentProvider: machinePaymentProviderCodeSchema.nullable(),
    paymentUrl: z.string().nullable(),
    paymentStatus: paymentStatusSchema.nullable(),
    orderStatus: orderStatusSchema.nullable(),
    totalAmountCents: z.number().int().nonnegative().nullable(),
    vending: z
      .object({
        commandNo: z.string().nullable(),
        status: vendingCommandStatusSchema.nullable(),
        lastError: z.string().nullable(),
        pickupReminder: z
          .object({
            stage: z
              .enum([
                "outlet_opened",
                "pickup_waiting",
                "pickup_completed",
                "pickup_timeout_warning",
              ])
              .optional(),
            level: z.enum(["info", "warning", "urgent"]),
            message: z.string(),
            warningNo: z.number().int().positive().nullable(),
            reportedAt: z.string(),
            remainingSeconds: z
              .number()
              .int()
              .nonnegative()
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable(),
    nextAction: machineOrderStatusNextActionSchema
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    maskedAuthCode: z.string().nullable(),
    paymentCodeAttempt: z
      .object({
        attemptNo: z.number().int().positive().nullable(),
        status: paymentCodeAttemptStatusSchema.nullable(),
        maskedAuthCode: z.string().nullable(),
        source: paymentCodeSourceSchema.nullable(),
        idempotencyKey: z.string().nullable(),
        submittedAt: z.string().nullable(),
        lastCheckedAt: z.string().nullable(),
        canRetry: z.boolean(),
        message: z.string().nullable(),
      })
      .nullable(),
    expiresAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    operatorHint: z.string().nullable(),
    updatedAt: z.string(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.orderNo && !snapshot.nextAction) {
      ctx.addIssue({
        code: "custom",
        path: ["nextAction"],
        message: "current transaction snapshots must include nextAction",
      });
    }
    if (snapshot.orderNo && snapshot.nextAction === "wait_payment") {
      if (!snapshot.paymentMethod) {
        ctx.addIssue({
          code: "custom",
          path: ["paymentMethod"],
          message:
            "awaiting-payment transaction snapshots must include paymentMethod",
        });
      }
      if (snapshot.totalAmountCents === null) {
        ctx.addIssue({
          code: "custom",
          path: ["totalAmountCents"],
          message:
            "awaiting-payment transaction snapshots must include totalAmountCents",
        });
      }
    }
  });

export const syncStatusSchema = z.object({
  mqttRunning: z.boolean(),
  mqttConnected: z.boolean(),
  brokerUrlMasked: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  lastCommandNo: z.string().nullable(),
  outboxSize: z.number().int().nonnegative(),
  outboxMax: z.number().int().positive(),
  outboxUsage: z.number().min(0),
  nextRetryAt: z.string().nullable(),
  lastError: z.string().nullable(),
  tlsAuthStatus: z.string().nullable(),
});

export const scannerStatusSchema = z.object({
  online: z.boolean(),
  adapter: z.string(),
  port: z.string().nullable(),
  level: z.string(),
  code: z.string(),
  message: z.string(),
  updatedAt: z.string(),
});

export const visionStatusSchema = z.object({
  enabled: z.boolean(),
  online: z.boolean(),
  message: z.string(),
  updatedAt: z.string().optional(),
  latestDiagnosticPayload: z.unknown().nullable().optional(),
});

export const remoteOpsStatusSchema = z.object({
  lastPolledAt: z.string().nullable(),
  pending: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  processing: z.string().nullable(),
});

const externalNaturalEnvironmentDiagnosticSchema = z.object({
  reason: z.enum([
    "machine_geo_location_missing",
    "machine_geo_timezone_missing",
    "provider_unavailable",
  ]),
  message: z.string().min(1),
});

const weatherConditionClassSchema = z.enum([
  "hail",
  "snow",
  "strong_wind",
  "moderate_or_heavy_rain",
  "light_rain",
  "other",
]);

const externalNaturalEnvironmentWeatherSchema = z.object({
  status: z.enum(["ready", "stale", "unavailable", "unconfigured"]),
  temperatureCelsius: z.number().optional(),
  conditionText: z.string().min(1).optional(),
  conditionCode: z.string().min(1).optional(),
  observedAt: z.string().optional(),
  windScale: z.number().int().nonnegative().optional(),
  windSpeedKph: z.number().nonnegative().optional(),
  weatherConditionClasses: z.array(weatherConditionClassSchema),
  primaryWeatherConditionClass: weatherConditionClassSchema.nullable(),
  diagnostic: externalNaturalEnvironmentDiagnosticSchema.optional(),
});

const externalNaturalEnvironmentLocalTimeSchema = z.object({
  status: z.enum(["ready", "unconfigured"]),
  timezone: z.string().min(1),
  localDate: z.string().min(1).optional(),
  localClock: z.string().min(1).optional(),
});

const externalNaturalEnvironmentSunSchema = z.object({
  status: z.enum(["ready", "stale", "unavailable", "unconfigured"]),
  sunriseAt: z.string().optional(),
  sunsetAt: z.string().optional(),
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

const externalNaturalEnvironmentCalendarSchema = z.object({
  status: z.enum(["ready", "unconfigured"]),
  localDate: z.string().min(1).optional(),
  festivals: z.array(festivalSchema),
  primaryFestival: festivalSchema.nullable(),
  solarTerm: solarTermSchema.nullable(),
  diagnostic: externalNaturalEnvironmentDiagnosticSchema.optional(),
});

export const externalNaturalEnvironmentProjectionSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("ready"),
      machineId: z.string().optional(),
      machineCode: z.string().nullable().optional(),
      checkedAt: z.string(),
      localTime: externalNaturalEnvironmentLocalTimeSchema,
      weather: externalNaturalEnvironmentWeatherSchema,
      sun: externalNaturalEnvironmentSunSchema,
      calendar: externalNaturalEnvironmentCalendarSchema,
    }),
    z.object({
      status: z.literal("stale"),
      machineId: z.string().optional(),
      machineCode: z.string().nullable().optional(),
      checkedAt: z.string(),
      localTime: externalNaturalEnvironmentLocalTimeSchema,
      weather: externalNaturalEnvironmentWeatherSchema,
      sun: externalNaturalEnvironmentSunSchema,
      calendar: externalNaturalEnvironmentCalendarSchema,
      diagnostic: externalNaturalEnvironmentDiagnosticSchema,
    }),
    z.object({
      status: z.literal("unavailable"),
      machineId: z.string().optional(),
      machineCode: z.string().nullable().optional(),
      checkedAt: z.string(),
      localTime: externalNaturalEnvironmentLocalTimeSchema.optional(),
      weather: externalNaturalEnvironmentWeatherSchema.optional(),
      sun: externalNaturalEnvironmentSunSchema.optional(),
      calendar: externalNaturalEnvironmentCalendarSchema.optional(),
      diagnostic: externalNaturalEnvironmentDiagnosticSchema,
    }),
    z.object({
      status: z.literal("unconfigured"),
      machineId: z.string().optional(),
      machineCode: z.string().nullable().optional(),
      checkedAt: z.string(),
      localTime: externalNaturalEnvironmentLocalTimeSchema.optional(),
      weather: externalNaturalEnvironmentWeatherSchema.optional(),
      sun: externalNaturalEnvironmentSunSchema.optional(),
      calendar: externalNaturalEnvironmentCalendarSchema.optional(),
      diagnostic: externalNaturalEnvironmentDiagnosticSchema,
    }),
  ],
);

export const naturalContextSnapshotSchema = z.object({
  status: z.enum(["ready", "stale", "unavailable", "unconfigured"]),
  machineCode: z.string().nullable().optional(),
  externalEnvironment: externalNaturalEnvironmentProjectionSchema,
  localSiteSignals: z.object({
    status: z.enum(["ok", "faulted", "unknown", "unavailable"]),
    temperatureCelsius: z.number().optional(),
    humidityRh: z.number().min(0).max(100).optional(),
    sampledAt: z.string().optional(),
  }),
  degraded: z.boolean(),
  customerFacingBlocked: z.boolean(),
  checkedAt: z.string(),
});

export const hardwareSelfCheckSchema = z.object({
  adapter: z.string(),
  online: z.boolean(),
  message: z.string(),
  portPath: z.string().nullable().optional(),
  resolutionSource: z.string().nullable().optional(),
  boundUsbIdentity: usbIdentitySchema.nullable().optional(),
  candidates: z.array(lowerControllerCandidateSchema).default([]),
  configUpdated: z.boolean().default(false),
});

export const environmentControlResultSchema =
  environmentControlResultPayloadSchema;

const saleReadinessComponentSchema = z.object({
  ready: z.boolean(),
  code: z.string(),
  message: z.string(),
});

export const machineSaleReadinessSchema = z.object({
  canStartNetworkAuthorizedSale: z.boolean(),
  blockingCodes: z.array(z.string()),
  components: z.object({
    platformReachability: saleReadinessComponentSchema,
    machineAuthentication: saleReadinessComponentSchema,
    activePlanogram: saleReadinessComponentSchema,
    paymentOptions: saleReadinessComponentSchema.extend({
      methods: z.array(
        z.object({
          method: z.string(),
          optionKey: z.string().nullable(),
          providerCode: z.string().nullable(),
          ready: z.boolean(),
          disabledReason: z.string().nullable().optional(),
        }),
      ),
    }),
    scannerCapability: saleReadinessComponentSchema,
    syncHealth: saleReadinessComponentSchema,
    wholeMachineBlockers: saleReadinessComponentSchema,
    productionDispensePath: saleReadinessComponentSchema.optional(),
    slotSaleSafety: saleReadinessComponentSchema
      .extend({
        blockedSlots: z
          .array(
            z.object({
              slotId: z.string(),
              slotCode: z.string(),
              slotSalesState: z.string(),
            }),
          )
          .default([]),
      })
      .optional(),
  }),
});

export const catalogSnapshotSchema = z.object({
  items: z.array(machineCatalogItemSchema),
  cached: z.boolean(),
  lastUpdatedAt: z.string().nullable(),
  source: z.string(),
  lastError: z.string().nullable(),
});

export const daemonEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("health_changed"),
    eventId: z.string(),
    updatedAt: z.string(),
    snapshot: healthSnapshotSchema,
  }),
  z.object({
    type: z.literal("ready_changed"),
    eventId: z.string(),
    updatedAt: z.string(),
    snapshot: readySnapshotSchema,
  }),
  z.object({
    type: z.literal("scanner_health_changed"),
    eventId: z.string(),
    updatedAt: z.string(),
    snapshot: scannerStatusSchema,
  }),
  z.object({
    type: z.literal("scanner_code"),
    eventId: z.string(),
    updatedAt: z.string(),
    maskedCode: z.string(),
    source: z.string(),
    scannedAtMs: z.number(),
  }),
  z.object({
    type: z.literal("transaction_changed"),
    eventId: z.string(),
    updatedAt: z.string(),
    orderNo: z.string(),
    status: z.string(),
  }),
  z.object({
    type: z.literal("mqtt_changed"),
    eventId: z.string(),
    updatedAt: z.string(),
    connected: z.boolean(),
    lastError: z.string().nullable(),
  }),
  z.object({
    type: z.literal("vision_changed"),
    eventId: z.string(),
    updatedAt: z.string(),
    enabled: z.boolean(),
    online: z.boolean(),
    message: z.string(),
    latestDiagnosticPayload: z.unknown().nullable().optional(),
  }),
  z.object({
    type: z.literal("remote_op_result"),
    eventId: z.string(),
    updatedAt: z.string(),
    opId: z.string(),
    status: z.string(),
  }),
]);

export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;
export type ReadySnapshot = z.infer<typeof readySnapshotSchema>;
export type ConfigSummary = z.infer<typeof configSummarySchema>;
export type BringUpSnapshot = z.infer<typeof bringUpSnapshotSchema>;
export type NetworkSettingsResponse = z.infer<
  typeof networkSettingsResponseSchema
>;
export type ProvisioningClaimResponse = z.infer<
  typeof provisioningClaimResponseSchema
>;
export type TransactionSnapshot = {
  orderId: string | null;
  orderNo: string | null;
  productSummary: unknown;
  paymentNo: string | null;
  paymentMethod: string | null;
  paymentProvider: string | null;
  paymentUrl: string | null;
  paymentStatus: string | null;
  orderStatus: string | null;
  totalAmountCents: number | null;
  vending: {
    commandNo: string | null;
    status: string | null;
    lastError: string | null;
    pickupReminder?: {
      stage?: string;
      level: "info" | "warning" | "urgent";
      message: string;
      warningNo: number | null;
      reportedAt: string;
      remainingSeconds?: number | null;
    } | null;
  } | null;
  nextAction: string | null;
  maskedAuthCode: string | null;
  paymentCodeAttempt: {
    attemptNo: number | null;
    status: string | null;
    maskedAuthCode: string | null;
    source: string | null;
    idempotencyKey: string | null;
    submittedAt: string | null;
    lastCheckedAt: string | null;
    canRetry: boolean;
    message: string | null;
  } | null;
  expiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  operatorHint: string | null;
  updatedAt: string;
};
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type ScannerStatus = z.infer<typeof scannerStatusSchema>;
export type VisionStatus = z.infer<typeof visionStatusSchema>;
export type RemoteOpsStatus = z.infer<typeof remoteOpsStatusSchema>;
export type NaturalContextSnapshot = z.infer<
  typeof naturalContextSnapshotSchema
>;
export type HardwareSelfCheck = z.infer<typeof hardwareSelfCheckSchema>;
export type EnvironmentControlResult = z.infer<
  typeof environmentControlResultSchema
>;
export type MachineSaleReadiness = z.infer<typeof machineSaleReadinessSchema>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type SaleViewSnapshot = z.infer<typeof machineSaleViewSnapshotSchema>;
export type DaemonEvent = z.infer<typeof daemonEventSchema>;

export { machinePaymentOptionsResponseSchema, machineSaleViewSnapshotSchema };
