import { z } from "zod";

import { orderStatusSchema } from "../enums/order-status";
import {
  paymentCodeAttemptStatusSchema,
  paymentMethodSchema,
  paymentStatusSchema,
} from "../enums/payment-status";
import { vendingCommandStatusSchema } from "../enums/vending";

// Remaining daemon snapshot convergence starts here: health, ready, config, bring-up,
// scanner, vision, natural-context, sync, and remote-operation snapshots should
// move through this Daemon IPC Contract Area in focused slices before a later
// Daemon IPC Contract Generation refactor.

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

export const daemonIpcOperationalReasonSchema = daemonIpcReadyReasonSchema;

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

export const daemonIpcSaleStartCapabilityPaymentOptionSchema = z
  .object({
    optionKey: z.string(),
    providerCode: z.string(),
    method: z.string(),
    displayName: z.string(),
    description: z.string(),
    icon: z.string(),
    recommended: z.boolean(),
    ready: z.boolean(),
    disabledReason: z.string().nullable(),
  })
  .strict();

export const daemonIpcSaleStartCapabilitySnapshotSchema = z
  .object({
    generation: z.string().min(1),
    revision: z.number().int().positive(),
    observedAt: z.string(),
    canStartSale: z.boolean(),
    blockers: z.array(daemonIpcOperationalReasonSchema),
    degradations: z.array(daemonIpcOperationalReasonSchema),
    paymentOptions: z
      .object({
        ready: z.boolean(),
        defaultOptionKey: z.string().nullable(),
        defaultProviderCode: z.string().nullable(),
        options: z.array(daemonIpcSaleStartCapabilityPaymentOptionSchema),
      })
      .strict(),
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

export type DaemonIpcScannerStatus = z.infer<
  typeof daemonIpcScannerStatusSchema
>;

export const daemonIpcStableSerialDeviceIdentitySchema = z
  .object({
    identityKey: z
      .string()
      .regex(
        /^(?:container:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|usb:usb\\vid_[0-9a-f]{4}&pid_[0-9a-f]{4}:[a-z0-9._-]+)$/,
      ),
    instanceId: z.string().nullable(),
    containerId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .nullable(),
    hardwareIds: z.array(
      z.string().regex(/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}$/),
    ),
    serialNumber: z.string().nullable(),
  })
  .strict();

const daemonIpcLocalDeviceRoleSchema = z.enum(["lower_controller", "scanner"]);

const daemonIpcLocalSerialRoleBindingSchema = z
  .object({
    identity: daemonIpcStableSerialDeviceIdentitySchema,
    confirmedAt: z.string(),
    confirmedBy: z.string(),
    testEvidenceCode: z.string(),
  })
  .strict();

export const daemonIpcDeviceBindingCandidateSchema = z
  .object({
    identity: daemonIpcStableSerialDeviceIdentitySchema,
    currentPort: z.string().regex(/^COM[1-9]\d*$/),
    friendlyName: z.string().nullable(),
    readiness: z.enum(["candidate", "ready", "blocked"]),
    readinessCode: z.string(),
    readinessMessage: z.string(),
  })
  .strict();

const daemonIpcDeviceDiscoveryDiagnosticSchema = z
  .object({
    currentPort: z.string(),
    friendlyName: z.string().nullable(),
    code: z.literal("DEVICE_IDENTITY_NOT_BINDABLE"),
    message: z.string(),
  })
  .strict();

export const daemonIpcDeviceRoleBindingSnapshotSchema = z
  .object({
    role: daemonIpcLocalDeviceRoleSchema,
    binding: daemonIpcLocalSerialRoleBindingSchema.nullable(),
    currentPort: z.string().nullable(),
    ready: z.boolean(),
    code: z.string(),
    message: z.string(),
    ambiguous: z.boolean(),
    ambiguityKind: z
      .enum(["candidate_selection", "duplicate_observation"])
      .nullable(),
    ambiguityPorts: z.array(z.string()),
    legacyPortHint: z.string().nullable(),
    candidates: z.array(daemonIpcDeviceBindingCandidateSchema),
    discoveryDiagnostics: z.array(daemonIpcDeviceDiscoveryDiagnosticSchema),
  })
  .strict()
  .superRefine((role, context) => {
    const identities = role.candidates.map(
      (candidate) => candidate.identity.identityKey,
    );
    const uniqueIdentities = new Set(identities);
    const invalid = (message: string) => {
      context.addIssue({ code: "custom", path: ["ambiguityKind"], message });
    };

    if (role.ambiguityKind === "candidate_selection") {
      if (
        !role.ambiguous ||
        role.code !== "DEVICE_BINDING_SELECTION_REQUIRED" ||
        uniqueIdentities.size < 2 ||
        uniqueIdentities.size !== identities.length
      ) {
        invalid(
          "candidate_selection requires multiple distinct stable identities and DEVICE_BINDING_SELECTION_REQUIRED",
        );
      }
    } else if (role.ambiguityKind === "duplicate_observation") {
      if (
        !role.ambiguous ||
        role.code !== "DEVICE_BINDING_AMBIGUOUS" ||
        identities.length < 2 ||
        uniqueIdentities.size === identities.length
      ) {
        invalid(
          "duplicate_observation requires repeated stable identity observations and DEVICE_BINDING_AMBIGUOUS",
        );
      }
    } else if (
      role.ambiguous ||
      [
        "DEVICE_BINDING_SELECTION_REQUIRED",
        "DEVICE_BINDING_AMBIGUOUS",
      ].includes(role.code)
    ) {
      invalid("non-ambiguous binding state requires a null ambiguityKind");
    }
  });

export const daemonIpcDeviceBindingSnapshotSchema = z
  .object({
    roles: z.array(daemonIpcDeviceRoleBindingSnapshotSchema).length(2),
  })
  .strict();

export const daemonIpcDeviceBindingTestResultSchema = z
  .object({
    role: daemonIpcLocalDeviceRoleSchema,
    identityKey: z.string(),
    currentPort: z.string(),
    success: z.boolean(),
    code: z.string(),
    message: z.string(),
    testedAt: z.string(),
    testEvidenceToken: z.uuid(),
    testEvidenceExpiresAt: z.iso.datetime({ offset: true }),
    observationRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    configRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const daemonIpcDeviceBindingActivationSchema = z
  .object({
    binding: daemonIpcLocalSerialRoleBindingSchema,
    currentPort: z.string(),
    ready: z.literal(true),
    code: z.literal("DEVICE_BINDING_ACTIVATED"),
    message: z.string(),
    unrelatedRuntimeRestarted: z.literal(false),
  })
  .strict();

export const daemonIpcAudioOutputObservationSchema = z
  .object({
    endpointId: z.string().trim().min(1).max(512),
    friendlyName: z.string().trim().min(1).max(512),
    isDefault: z.boolean(),
  })
  .strict();

export const daemonIpcAudioOutputBindingSchema = z
  .object({
    endpointId: z.string().trim().min(1).max(512),
    friendlyName: z.string().trim().min(1).max(512).nullable(),
    confirmedHeardAt: z.iso.datetime({ offset: true }),
    confirmedObservationRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const daemonIpcAudioOutputBindingSnapshotSchema = z
  .object({
    binding: daemonIpcAudioOutputBindingSchema.nullable(),
    currentObservation: daemonIpcAudioOutputObservationSchema.nullable(),
    observationRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    candidates: z.array(daemonIpcAudioOutputObservationSchema),
    ready: z.boolean(),
    code: z.enum([
      "AUDIO_OUTPUT_BINDING_READY",
      "AUDIO_OUTPUT_BINDING_REMOVED",
      "AUDIO_OUTPUT_BINDING_REQUIRED",
      "AUDIO_OUTPUT_ENUMERATION_UNAVAILABLE",
    ]),
    message: z.string(),
  })
  .strict();

const daemonIpcAudioCueSettingsSchema = z
  .object({
    enabled: z.boolean(),
    categories: z
      .object({
        presence: z.boolean(),
        transaction: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const daemonIpcAudioOutputTestRequestSchema = z
  .object({
    endpointId: z.string().trim().min(1).max(512),
    audioCueSettings: daemonIpcAudioCueSettingsSchema,
    machineAudioVolume: z.number().positive().max(1),
    challenge: z
      .string()
      .regex(/^[a-f0-9]{32,128}$/)
      .optional(),
  })
  .strict();

export const daemonIpcAudioOutputTestResponseSchema = z
  .object({
    endpointId: z.string().trim().min(1).max(512),
    testEvidenceToken: z.uuid(),
    testEvidenceExpiresAt: z.iso.datetime({ offset: true }),
    observationRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    observationGeneration: z.number().int().nonnegative(),
    configRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    configGeneration: z.number().int().nonnegative(),
    proposedSettingsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    challenge: z
      .string()
      .regex(/^[a-f0-9]{32,128}$/)
      .optional(),
  })
  .strict();

export const daemonIpcAudioOutputConfirmRequestSchema = z
  .object({
    endpointId: z.string().trim().min(1).max(512),
    testEvidenceToken: z.uuid(),
    heard: z.literal(true),
    audioCueSettings: daemonIpcAudioCueSettingsSchema,
    machineAudioVolume: z.number().positive().max(1),
  })
  .strict();

export type DaemonIpcAudioOutputBindingSnapshot = z.infer<
  typeof daemonIpcAudioOutputBindingSnapshotSchema
>;
export type DaemonIpcAudioOutputTestRequest = z.infer<
  typeof daemonIpcAudioOutputTestRequestSchema
>;
export type DaemonIpcAudioOutputTestResponse = z.infer<
  typeof daemonIpcAudioOutputTestResponseSchema
>;
export type DaemonIpcAudioOutputConfirmRequest = z.infer<
  typeof daemonIpcAudioOutputConfirmRequestSchema
>;

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

const daemonIpcKnownEventEnvelopeSchema = daemonIpcEventEnvelopeSchema.strict();

export const daemonIpcKnownEventNotificationTypeSchema = z.enum([
  "health_changed",
  "ready_changed",
  "sale_start_capability_changed",
  "scanner_health_changed",
  "scanner_code",
  "transaction_changed",
  "mqtt_changed",
  "vision_changed",
  "runtime_reconfigure_requested",
  "remote_op_result",
]);

const daemonIpcKnownEventNotificationTypes = new Set<string>(
  daemonIpcKnownEventNotificationTypeSchema.options,
);

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

export const daemonIpcSaleStartCapabilityChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("sale_start_capability_changed"),
      generation: z.string().min(1),
      revision: z.number().int().positive(),
    })
    .strict();

export const daemonIpcScannerHealthChangedEventSchema =
  daemonIpcKnownEventEnvelopeSchema
    .extend({
      type: z.literal("scanner_health_changed"),
      snapshot: daemonIpcScannerStatusSchema,
    })
    .strict();

export const daemonIpcScannerCodeEventSchema = daemonIpcKnownEventEnvelopeSchema
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

export const daemonIpcMqttChangedEventSchema = daemonIpcKnownEventEnvelopeSchema
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
    daemonIpcSaleStartCapabilityChangedEventSchema,
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
    .loose()
    .transform((event) => ({ ...event, known: false as const }));

export const daemonIpcEventNotificationSchema = z
  .unknown()
  .transform((value, ctx) => {
    const envelope = daemonIpcEventEnvelopeSchema.loose().safeParse(value);
    if (!envelope.success) {
      ctx.addIssue({
        code: "custom",
        message: envelope.error.message,
      });
      return z.NEVER;
    }

    if (daemonIpcKnownEventNotificationTypes.has(envelope.data.type)) {
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

export function normalizeLegacyDaemonIpcCheckoutFlowActionForRecovery(
  action: unknown,
): DaemonIpcCheckoutFlowAction | null {
  if (action === "submit_payment") {
    return "wait_payment";
  }
  if (action === "collect_goods") {
    return "dispensing";
  }
  const current = daemonIpcCheckoutFlowActionSchema.safeParse(action);
  return current.success ? current.data : null;
}

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
    commandId: z.string().nullable(),
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
    paymentId: z.string().nullable(),
    paymentNo: z.string().nullable(),
    paymentMethod: paymentMethodSchema.nullable(),
    paymentProvider: daemonIpcMachinePaymentProviderSchema.nullable(),
    paymentUrl: z.string().nullable(),
    paymentStatus: paymentStatusSchema.nullable(),
    orderStatus: orderStatusSchema.nullable(),
    totalAmountCents: z.number().int().nonnegative().nullable(),
    vending: daemonIpcVendingSummarySchema.nullable(),
    nextAction: daemonIpcCheckoutFlowActionSchema.nullable(),
    maskedAuthCode: z.string().nullable(),
    paymentCodeAttempt: daemonIpcPaymentCodeAttemptSummarySchema.nullable(),
    expiresAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    operatorHint: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();

export type DaemonIpcTransactionSnapshot = z.infer<
  typeof daemonIpcTransactionSnapshotSchema
>;
export type DaemonIpcPaymentCodeAttemptSummary = z.infer<
  typeof daemonIpcPaymentCodeAttemptSummarySchema
>;
export type DaemonIpcVendingSummary = z.infer<
  typeof daemonIpcVendingSummarySchema
>;

export function validateDaemonIpcTransactionSnapshotBoundary(
  snapshot: DaemonIpcTransactionSnapshot,
): DaemonIpcTransactionSnapshot {
  const issues: string[] = [];

  if (snapshot.orderNo && !snapshot.nextAction) {
    issues.push("current transaction snapshots must include nextAction");
  }
  if (snapshot.orderNo && snapshot.nextAction === "wait_payment") {
    if (!snapshot.paymentMethod) {
      issues.push(
        "awaiting-payment transaction snapshots must include paymentMethod",
      );
    }
    if (snapshot.totalAmountCents === null) {
      issues.push(
        "awaiting-payment transaction snapshots must include totalAmountCents",
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }

  return snapshot;
}

export function parseDaemonIpcTransactionSnapshotBoundary(
  value: unknown,
): DaemonIpcTransactionSnapshot {
  return validateDaemonIpcTransactionSnapshotBoundary(
    daemonIpcTransactionSnapshotSchema.parse(value),
  );
}

export type DaemonIpcJsonSchemaDocument = {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  $defs?: Record<string, unknown>;
} & Record<string, unknown>;

function exportDaemonIpcJsonSchemaDefinition(
  name: string,
  schema: z.ZodType,
): Record<string, unknown> {
  try {
    const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(
      schema,
    ) as Record<string, unknown>;
    return jsonSchema;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown JSON Schema error";
    throw new Error(
      `Daemon IPC JSON Schema export failed for ${name}: ${message}`,
    );
  }
}

export function exportDaemonIpcJsonSchemaDefinitions(
  definitions: Record<string, z.ZodType>,
): DaemonIpcJsonSchemaDocument {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: Object.fromEntries(
      Object.entries(definitions).map(([name, schema]) => [
        name,
        exportDaemonIpcJsonSchemaDefinition(name, schema),
      ]),
    ),
  };
}

export function exportDaemonIpcTransactionCheckoutJsonSchema(): DaemonIpcJsonSchemaDocument {
  const root = exportDaemonIpcJsonSchemaDefinition(
    "CurrentTransactionSnapshot",
    daemonIpcTransactionSnapshotSchema,
  );
  const definitions = exportDaemonIpcJsonSchemaDefinitions({
    CheckoutFlowAction: daemonIpcCheckoutFlowActionSchema,
    DispenseProgressObservationStage:
      daemonIpcDispenseProgressObservationStageSchema,
    PaymentCodeAttemptSummary: daemonIpcPaymentCodeAttemptSummarySchema,
    PickupReminder: daemonIpcPickupReminderSchema,
    VendingSummary: daemonIpcVendingSummarySchema,
  });

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "CurrentTransactionSnapshot",
    ...root,
    $defs: definitions.$defs,
  };
}

export function exportDaemonIpcScannerStatusJsonSchema(): DaemonIpcJsonSchemaDocument {
  const root = exportDaemonIpcJsonSchemaDefinition(
    "ScannerRuntimeStatus",
    daemonIpcScannerStatusSchema,
  );

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "ScannerRuntimeStatus",
    ...root,
  };
}

export function exportDaemonIpcSaleStartCapabilityJsonSchema(): DaemonIpcJsonSchemaDocument {
  const root = exportDaemonIpcJsonSchemaDefinition(
    "SaleStartCapabilitySnapshot",
    daemonIpcSaleStartCapabilitySnapshotSchema,
  );

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "SaleStartCapabilitySnapshot",
    ...root,
  };
}
