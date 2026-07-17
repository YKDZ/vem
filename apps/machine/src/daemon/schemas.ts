import {
  type DaemonIpcKnownEventNotification,
  type DaemonIpcUnknownEventNotification,
  type DaemonIpcTransactionSnapshot,
  daemonIpcEventNotificationSchema,
  daemonIpcDeviceBindingActivationSchema,
  daemonIpcDeviceBindingSnapshotSchema,
  daemonIpcDeviceBindingTestResultSchema,
  daemonIpcSaleStartCapabilityChangedEventSchema,
  daemonIpcSaleStartCapabilitySnapshotSchema,
  daemonIpcScannerStatusSchema,
  environmentControlResultPayloadSchema,
  machineCatalogItemSchema,
  machinePaymentOptionsResponseSchema,
  paymentProviderEnvironmentDiagnosticSchema,
  machineSaleViewSnapshotSchema,
  parseDaemonIpcTransactionSnapshotBoundary,
  visionCameraMaintenanceConfirmResponseSchema,
  visionCameraMaintenanceContractSchema,
  visionCameraMaintenanceTestResponseSchema,
} from "@vem/shared";
import { z } from "zod";

export { paymentProviderEnvironmentDiagnosticSchema };

const usbIdentitySchema = z.object({
  vendorId: z.string(),
  productId: z.string(),
  serialNumber: z.string().nullable().default(null),
});

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
  updatedAt: z.string(),
});

export const saleStartCapabilitySnapshotSchema =
  daemonIpcSaleStartCapabilitySnapshotSchema;
export const saleStartCapabilityChangedEventSchema =
  daemonIpcSaleStartCapabilityChangedEventSchema;

const networkDiagnosticSchema = z.object({
  component: z.string(),
  level: z.string(),
  code: z.string(),
  message: z.string(),
  evidence: z
    .object({
      source: z.enum([
        "local_adapter",
        "local_address",
        "local_default_route",
        "platform_api",
        "mqtt_broker",
      ]),
      status: z.enum(["ready", "failed", "pending", "not_configured"]),
      reasonCode: z.string(),
      reason: z.string(),
      recoveryAction: z.string(),
    })
    .optional(),
});

export const networkSettingsResponseSchema = z.object({
  status: z.enum(["connected", "failed", "unsupported"]),
  ssid: z.string(),
  hidden: z.boolean(),
  diagnostics: z.array(networkDiagnosticSchema),
  operatorGuidance: z.string(),
  updatedAt: z.string(),
});

export const wifiNetworkSchema = z.object({
  ssid: z.string(),
  signalQuality: z.number().int().min(0).max(100),
  security: z.enum([
    "open",
    "wpa_personal",
    "wpa2_personal",
    "wpa3_personal",
    "enterprise",
    "unknown",
  ]),
  connected: z.boolean(),
  profileSaved: z.boolean(),
});

export const wifiScanResponseSchema = z.object({
  status: z.enum(["available", "failed", "unsupported"]),
  networks: z.array(wifiNetworkSchema),
  operatorGuidance: z.string(),
  updatedAt: z.string(),
});

export const provisioningClaimResponseSchema = z.object({
  status: z.literal("provisioned"),
  machineCode: z.string(),
  restartRequested: z.boolean(),
});

export const maintenanceEnrollmentStatusSchema = z.object({
  state: z.enum([
    "not_enrolled",
    "tunnel_applied",
    "handshake_pending",
    "handshake_verified",
    "handshake_evidence_persist_pending",
    "maintenance_recovery_pending",
    "lifecycle_unavailable",
    "tunnel_apply_pending",
    "tunnel_degraded",
    "reclaim_request_pending",
    "reclaim_handshake_pending",
    "reclaim_handshake_evidence_persist_pending",
    "reclaim_handshake_verified",
    "reclaim_timed_out_recovered",
    "failed",
    "decommissioned",
  ]),
  publicKey: z.string().nullable(),
  tunnelAddress: z.string().nullable(),
  endpoint: z.string().nullable(),
  handshakeVerified: z.boolean(),
  tunnelConnected: z.boolean().default(false),
  firstHandshakeVerifiedAt: z.string().nullable().default(null),
  lastHandshakeAt: z.string().nullable(),
  lastError: z.string().nullable(),
  alertCode: z.string().nullable().default(null),
  activePublicKey: z.string().nullable().default(null),
  pendingPublicKey: z.string().nullable().default(null),
  reclaimExpiresAt: z.string().nullable().default(null),
  activeIdentityRetained: z.boolean().default(false),
  updatedAt: z.string(),
});

type TransactionSnapshotParseResult =
  | { success: true; data: DaemonIpcTransactionSnapshot }
  | { success: false; error: unknown };

export const transactionSnapshotSchema = {
  parse: parseDaemonIpcTransactionSnapshotBoundary,
  safeParse(value: unknown): TransactionSnapshotParseResult {
    try {
      return {
        success: true,
        data: parseDaemonIpcTransactionSnapshotBoundary(value),
      };
    } catch (error) {
      return { success: false, error };
    }
  },
};

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

export const scannerStatusSchema = daemonIpcScannerStatusSchema;
export const deviceBindingSnapshotSchema = daemonIpcDeviceBindingSnapshotSchema;
export const deviceBindingTestResultSchema =
  daemonIpcDeviceBindingTestResultSchema;
export const deviceBindingActivationSchema =
  daemonIpcDeviceBindingActivationSchema;

export const visionStatusSchema = z.object({
  enabled: z.boolean(),
  online: z.boolean(),
  message: z.string(),
  updatedAt: z.string().optional(),
  latestDiagnosticPayload: z.unknown().nullable().optional(),
});

export const visionCameraMaintenanceContractResponseSchema =
  visionCameraMaintenanceContractSchema;
export const visionCameraMaintenanceTestResponseProxySchema =
  visionCameraMaintenanceTestResponseSchema;
export const visionCameraMaintenanceConfirmResponseProxySchema =
  visionCameraMaintenanceConfirmResponseSchema;

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

export const manualDispenseDiagnosticResultSchema = z.object({
  diagnosticId: z.string().min(1),
  outcome: z.enum(["completed", "failed", "result_unknown"]),
  errorCode: z.string().nullable().optional(),
  reportedAt: z.string().optional(),
  stockReconciliationRequired: z.literal(true),
  reconciliationStatus: z.literal("open"),
  replayed: z.boolean(),
});

export const environmentControlResultSchema =
  environmentControlResultPayloadSchema;

export const catalogSnapshotSchema = z.object({
  items: z.array(machineCatalogItemSchema),
  cached: z.boolean(),
  lastUpdatedAt: z.string().nullable(),
  source: z.string(),
  lastError: z.string().nullable(),
});

export const daemonEventSchema = daemonIpcEventNotificationSchema;

export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;
export type ReadySnapshot = z.infer<typeof readySnapshotSchema>;
export type NetworkSettingsResponse = z.infer<
  typeof networkSettingsResponseSchema
>;
export type ProvisioningClaimResponse = z.infer<
  typeof provisioningClaimResponseSchema
>;
export type WifiNetwork = z.infer<typeof wifiNetworkSchema>;
export type WifiScanResponse = z.infer<typeof wifiScanResponseSchema>;
export type MaintenanceEnrollmentStatus = z.infer<
  typeof maintenanceEnrollmentStatusSchema
>;
export type TransactionSnapshot = DaemonIpcTransactionSnapshot;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type ScannerStatus = z.infer<typeof scannerStatusSchema>;
export type DeviceBindingSnapshot = z.infer<typeof deviceBindingSnapshotSchema>;
export type DeviceBindingTestResult = z.infer<
  typeof deviceBindingTestResultSchema
>;
export type DeviceBindingActivation = z.infer<
  typeof deviceBindingActivationSchema
>;
export type VisionStatus = z.infer<typeof visionStatusSchema>;
export type VisionCameraMaintenanceContract = z.infer<
  typeof visionCameraMaintenanceContractResponseSchema
>;
export type VisionCameraMaintenanceTestResponse = z.infer<
  typeof visionCameraMaintenanceTestResponseProxySchema
>;
export type VisionCameraMaintenanceConfirmResponse = z.infer<
  typeof visionCameraMaintenanceConfirmResponseProxySchema
>;
export type RemoteOpsStatus = z.infer<typeof remoteOpsStatusSchema>;
export type NaturalContextSnapshot = z.infer<
  typeof naturalContextSnapshotSchema
>;
export type HardwareSelfCheck = z.infer<typeof hardwareSelfCheckSchema>;
export type ManualDispenseDiagnosticResult = z.infer<
  typeof manualDispenseDiagnosticResultSchema
>;
export type EnvironmentControlResult = z.infer<
  typeof environmentControlResultSchema
>;
export type SaleStartCapabilitySnapshot = z.infer<
  typeof saleStartCapabilitySnapshotSchema
>;
export type SaleStartCapabilityChangedEvent = z.infer<
  typeof saleStartCapabilityChangedEventSchema
>;
export type PaymentProviderEnvironmentDiagnostic = z.infer<
  typeof paymentProviderEnvironmentDiagnosticSchema
>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type SaleViewMediaDiagnostic = {
  reference: string | null;
  diagnosticKey: string;
  message: string;
};

export type SaleViewSnapshot = z.infer<typeof machineSaleViewSnapshotSchema> & {
  mediaDiagnostics?: readonly SaleViewMediaDiagnostic[];
};
export type DaemonEvent = DaemonIpcKnownEventNotification;
export type UnknownDaemonEvent = DaemonIpcUnknownEventNotification;

export { machinePaymentOptionsResponseSchema, machineSaleViewSnapshotSchema };
