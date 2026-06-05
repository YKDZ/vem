import {
  machineCatalogItemSchema,
  machinePaymentOptionsResponseSchema,
  machineSaleViewSnapshotSchema,
} from "@vem/shared";
import { z } from "zod";

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
  public: z.object({
    machineCode: z.string().nullable(),
    apiBaseUrl: z.string(),
    mqttUrl: z.string(),
    mqttUsername: z.string().nullable(),
    hardwareAdapter: z.enum(["mock", "serial", "bluetooth", "vendor_sdk"]),
    serialPortPath: z.string().nullable(),
    lowerControllerUsbIdentity: usbIdentitySchema.nullable().optional(),
    scannerAdapter: z.enum(["disabled", "serial_text"]),
    scannerSerialPortPath: z.string().nullable(),
    scannerBaudRate: z.number().int(),
    scannerFrameSuffix: z.enum(["crlf", "lf", "cr", "none"]),
    visionEnabled: z.boolean(),
    visionWsUrl: z.string(),
    visionAutoStart: z.boolean(),
    visionProcessCommand: z.string().nullable(),
    visionProcessArgs: z.string().nullable(),
    visionRequestTimeoutMs: z.number().int(),
    kioskMode: z.boolean(),
    stockMovementRetentionDays: z.number().int().min(1).max(366).default(30),
  }),
  machineSecretConfigured: z.boolean(),
  mqttSigningSecretConfigured: z.boolean(),
  mqttPasswordConfigured: z.boolean(),
});

export const transactionSnapshotSchema = z.object({
  orderId: z.string().nullable(),
  orderNo: z.string().nullable(),
  productSummary: z.unknown().nullable(),
  paymentNo: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  paymentProvider: z.string().nullable(),
  paymentUrl: z.string().nullable(),
  paymentStatus: z.string().nullable(),
  orderStatus: z.string().nullable(),
  totalAmountCents: z.number().int().nonnegative().nullable(),
  vending: z
    .object({
      commandNo: z.string().nullable(),
      status: z.string().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  nextAction: z.string().nullable(),
  maskedAuthCode: z.string().nullable(),
  paymentCodeAttempt: z
    .object({
      attemptNo: z.number().int().positive().nullable(),
      status: z.string().nullable(),
      maskedAuthCode: z.string().nullable(),
      source: z.string().nullable(),
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
});

export const remoteOpsStatusSchema = z.object({
  lastPolledAt: z.string().nullable(),
  pending: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  processing: z.string().nullable(),
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
export type TransactionSnapshot = z.infer<typeof transactionSnapshotSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type ScannerStatus = z.infer<typeof scannerStatusSchema>;
export type VisionStatus = z.infer<typeof visionStatusSchema>;
export type RemoteOpsStatus = z.infer<typeof remoteOpsStatusSchema>;
export type HardwareSelfCheck = z.infer<typeof hardwareSelfCheckSchema>;
export type MachineSaleReadiness = z.infer<typeof machineSaleReadinessSchema>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type SaleViewSnapshot = z.infer<typeof machineSaleViewSnapshotSchema>;
export type DaemonEvent = z.infer<typeof daemonEventSchema>;

export { machinePaymentOptionsResponseSchema, machineSaleViewSnapshotSchema };
