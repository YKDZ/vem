import { z } from "zod";

import { orderStatusSchema } from "../enums/order-status";
import {
  paymentCodeAttemptStatusSchema,
  paymentMethodSchema,
  paymentStatusSchema,
} from "../enums/payment-status";
import { vendingCommandStatusSchema } from "../enums/vending";

const daemonIpcComponentHealthSchema = z
  .object({
    component: z.string(),
    level: z.string(),
    code: z.string(),
    message: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const daemonIpcReadyReasonSchema = z
  .object({
    code: z.string(),
    component: z.string(),
    message: z.string(),
  })
  .strict();

export const daemonIpcHealthSnapshotSchema = z
  .object({
    status: z.enum([
      "healthy",
      "degraded",
      "offline",
      "maintenance",
      "starting",
    ]),
    process: daemonIpcComponentHealthSchema,
    components: z.array(daemonIpcComponentHealthSchema),
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
      .strict()
      .nullable(),
    operatorReason: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const daemonIpcReadySnapshotSchema = z
  .object({
    ready: z.boolean(),
    canSell: z.boolean(),
    mode: z.string(),
    blockingCodes: z.array(z.string()),
    blockingReasons: z.array(daemonIpcReadyReasonSchema),
    degradedReasons: z.array(daemonIpcReadyReasonSchema),
    suggestedRoute: z.enum([
      "maintenance",
      "offline",
      "catalog",
      "payment",
      "dispensing",
      "result",
    ]),
    updatedAt: z.string(),
  })
  .strict();

export const daemonIpcScannerStatusSchema = z
  .object({
    online: z.boolean(),
    adapter: z.string(),
    port: z.string().nullable(),
    level: z.string(),
    code: z.string(),
    message: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const daemonIpcEventEnvelopeMetadataSchema = z
  .object({
    schemaVersion: z.number().int().positive().optional(),
    traceId: z.string().optional(),
  })
  .catchall(z.unknown());

const daemonIpcEventEnvelopeDiagnosticsSchema = z
  .object({})
  .catchall(z.unknown());

const daemonIpcEventEnvelopeSchema = z
  .object({
    type: z.string(),
    eventId: z.string(),
    updatedAt: z.string(),
    metadata: daemonIpcEventEnvelopeMetadataSchema.optional(),
    diagnostics: daemonIpcEventEnvelopeDiagnosticsSchema.optional(),
  })
  .strict();

const daemonIpcKnownEventEnvelopeSchema =
  daemonIpcEventEnvelopeSchema.strict();

export const daemonIpcKnownEventNotificationTypeSchema = z.enum([
  "health_changed",
  "ready_changed",
  "scanner_health_changed",
  "scanner_code",
  "transaction_changed",
  "mqtt_changed",
  "vision_changed",
  "runtime_reconfigure_requested",
  "remote_op_result",
]);

export const daemonIpcHealthChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("health_changed"),
      snapshot: daemonIpcHealthSnapshotSchema,
    })
    .strict();

export const daemonIpcReadyChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("ready_changed"),
      snapshot: daemonIpcReadySnapshotSchema,
    })
    .strict();

export const daemonIpcScannerHealthChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("scanner_health_changed"),
      snapshot: daemonIpcScannerStatusSchema,
    })
    .strict();

export const daemonIpcScannerCodeEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("scanner_code"),
      maskedCode: z.string(),
      source: z.string(),
      scannedAtMs: z.number(),
    })
    .strict();

export const daemonIpcTransactionChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("transaction_changed"),
      orderNo: z.string(),
      status: z.string(),
    })
    .strict();

export const daemonIpcMqttChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("mqtt_changed"),
      connected: z.boolean(),
      lastError: z.string().nullable(),
    })
    .strict();

export const daemonIpcVisionChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("vision_changed"),
      enabled: z.boolean(),
      online: z.boolean(),
      message: z.string(),
      latestDiagnosticPayload: z.unknown().nullable().optional(),
    })
    .strict();

export const daemonIpcRuntimeReconfigureRequestedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("runtime_reconfigure_requested"),
      reason: z.string(),
      machineCode: z.string().nullable().optional(),
    })
    .strict();

export const daemonIpcRemoteOpResultEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("remote_op_result"),
      opId: z.string(),
      status: z.string(),
    })
    .strict();

export const daemonIpcKnownEventNotificationSchema = z.discriminatedUnion(
  "type",
  [
    daemonIpcHealthChangedEventSchema,
    daemonIpcReadyChangedEventSchema,
    daemonIpcScannerHealthChangedEventSchema,
    daemonIpcScannerCodeEventSchema,
    daemonIpcTransactionChangedEventSchema,
    daemonIpcMqttChangedEventSchema,
    daemonIpcVisionChangedEventSchema,
    daemonIpcRuntimeReconfigureRequestedEventSchema,
    daemonIpcRemoteOpResultEventSchema,
  ],
);

export const daemonIpcUnknownEventNotificationSchema =
  daemonIpcEventEnvelopeSchema
    .passthrough()
    .transform((event) => ({ ...event, known: false as const }));

export const daemonIpcEventNotificationSchema = z
  .unknown()
  .transform((value, ctx) => {
    const envelope = daemonIpcEventEnvelopeSchema.passthrough().safeParse(value);
    if (!envelope.success) {
      ctx.addIssue({
        code: "custom",
        message: envelope.error.message,
      });
      return z.NEVER;
    }

    if (
      daemonIpcKnownEventNotificationTypeSchema.options.includes(
        envelope.data.type as never,
      )
    ) {
      const known = daemonIpcKnownEventNotificationSchema.safeParse(value);
      if (!known.success) {
        ctx.addIssue({
          code: "custom",
          message: known.error.message,
        });
        return z.NEVER;
      }
      return known.data;
    }

    return daemonIpcUnknownEventNotificationSchema.parse(value);
  });

export type DaemonIpcKnownEventNotification = z.infer<
  typeof daemonIpcKnownEventNotificationSchema
>;
export type DaemonIpcUnknownEventNotification = z.infer<
  typeof daemonIpcUnknownEventNotificationSchema
>;
export type DaemonIpcEventNotification = z.infer<
  typeof daemonIpcEventNotificationSchema
>;

export const daemonIpcCheckoutFlowActionSchema = z.enum([
  "wait_payment",
  "dispensing",
  "success",
  "payment_failed",
  "payment_expired",
  "dispense_failed",
  "refund_pending",
  "refunded",
  "manual_handling",
  "closed",
]);

export type DaemonIpcCheckoutFlowAction = z.infer<
  typeof daemonIpcCheckoutFlowActionSchema
>;

export const daemonIpcMachinePaymentProviderSchema = z.enum([
  "mock",
  "wechat_pay",
  "alipay",
]);

export const daemonIpcPaymentCodeSourceSchema = z.enum([
  "serial_text",
  "tauri_scanner",
  "browser_test",
  "manual_dev",
]);

export const daemonIpcDispenseProgressObservationStageSchema = z.enum([
  "outlet_opened",
  "pickup_waiting",
  "pickup_timeout_warning",
  "pickup_completed",
  "reset_completed",
]);

export type DaemonIpcDispenseProgressObservationStage = z.infer<
  typeof daemonIpcDispenseProgressObservationStageSchema
>;

export const daemonIpcPickupReminderSchema = z
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
    remainingSeconds: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const daemonIpcVendingSummarySchema = z
  .object({
    commandNo: z.string().nullable(),
    status: vendingCommandStatusSchema.nullable(),
    lastError: z.string().nullable(),
    pickupReminder: daemonIpcPickupReminderSchema.nullable().optional(),
  })
  .strict();

export const daemonIpcPaymentCodeAttemptSummarySchema = z
  .object({
    attemptNo: z.number().int().positive().nullable(),
    status: paymentCodeAttemptStatusSchema.nullable(),
    maskedAuthCode: z.string().nullable(),
    source: daemonIpcPaymentCodeSourceSchema.nullable(),
    idempotencyKey: z.string().nullable(),
    submittedAt: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
    canRetry: z.boolean(),
    message: z.string().nullable(),
  })
  .strict();

export const daemonIpcTransactionSnapshotSchema = z
  .object({
    orderId: z.string().nullable(),
    orderNo: z.string().nullable(),
    productSummary: z.unknown().nullable(),
    paymentNo: z.string().nullable(),
    paymentMethod: paymentMethodSchema.nullable(),
    paymentProvider: daemonIpcMachinePaymentProviderSchema.nullable(),
    paymentUrl: z.string().nullable(),
    paymentStatus: paymentStatusSchema.nullable(),
    orderStatus: orderStatusSchema.nullable(),
    totalAmountCents: z.number().int().nonnegative().nullable(),
    vending: daemonIpcVendingSummarySchema.nullable(),
    nextAction: daemonIpcCheckoutFlowActionSchema
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    maskedAuthCode: z.string().nullable(),
    paymentCodeAttempt: daemonIpcPaymentCodeAttemptSummarySchema.nullable(),
    expiresAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    operatorHint: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict()
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

export type DaemonIpcTransactionSnapshot = z.infer<
  typeof daemonIpcTransactionSnapshotSchema
>;
export type DaemonIpcPaymentCodeAttemptSummary = z.infer<
  typeof daemonIpcPaymentCodeAttemptSummarySchema
>;
export type DaemonIpcVendingSummary = z.infer<
  typeof daemonIpcVendingSummarySchema
>;
