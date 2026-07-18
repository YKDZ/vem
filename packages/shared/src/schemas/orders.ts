import { z } from "zod";

import {
  orderFulfillmentStateSchema,
  orderPaymentStateSchema,
  orderStatusSchema,
} from "../enums/order-status";
import {
  paymentCodeAttemptStatusSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  refundStatusSchema,
} from "../enums/payment-status";
import { vendingCommandStatusSchema } from "../enums/vending";
import { daemonIpcCheckoutFlowActionSchema } from "./daemon-ipc";
import { createPageResultSchema, pageQuerySchema } from "./pagination";

type MachineOrderProfileSnapshot = {
  personPresent: boolean;
  heightCm?: number | null;
  bodyType?: string;
  upperColor?: string;
  confidence?: number;
};

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length < 1 || value.length > maxLength) return undefined;
  return value;
}

function sanitizeMachineOrderProfileSnapshot(
  value: unknown,
): MachineOrderProfileSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const personPresent = Reflect.get(value, "personPresent");
  if (typeof personPresent !== "boolean") return null;

  const snapshot: MachineOrderProfileSnapshot = {
    personPresent,
  };
  const heightCm = Reflect.get(value, "heightCm");
  if (heightCm === null) {
    snapshot.heightCm = null;
  } else if (
    typeof heightCm === "number" &&
    heightCm >= 80 &&
    heightCm <= 240
  ) {
    snapshot.heightCm = heightCm;
  }
  const bodyType = boundedString(Reflect.get(value, "bodyType"), 32);
  if (bodyType !== undefined) snapshot.bodyType = bodyType;
  const upperColor = boundedString(Reflect.get(value, "upperColor"), 32);
  if (upperColor !== undefined) snapshot.upperColor = upperColor;
  const confidence = Reflect.get(value, "confidence");
  if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) {
    snapshot.confidence = confidence;
  }
  return snapshot;
}

const machineOrderProfileSnapshotSchema = z
  .unknown()
  .transform((value) => sanitizeMachineOrderProfileSnapshot(value));

export const orderQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  machineId: z.uuid().optional(),
  status: orderStatusSchema.optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const adminOrderListQuerySchema = orderQuerySchema.extend(
  pageQuerySchema.shape,
);

export const orderRecoveryActionNameSchema = z.enum([
  "confirm_dispensed",
  "confirm_not_dispensed",
  "request_refund",
  "compensation_dispense",
]);

export const orderRecoveryActionSchema = z.strictObject({
  action: orderRecoveryActionNameSchema,
  note: z.string().trim().min(1).max(500),
});

export const adminOrderContractNoBodySchema = z.strictObject({});

export const orderRecoveryActionResponseSchema = z.strictObject({
  action: orderRecoveryActionNameSchema,
  recoveryActionId: z.string().min(1).max(128),
  commandId: z.string().min(1).max(128),
  commandNo: z.string().min(1).max(64).optional(),
  status: z.string().min(1).max(64),
});

export const orderRefundRequestResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  refundNo: z.string().min(1).max(64),
  paymentId: z.string().min(1).max(128),
  orderId: z.string().min(1).max(128),
  amountCents: z.int().nonnegative(),
  status: refundStatusSchema,
  providerRefundNo: z.string().max(128).nullable(),
  reason: z.string().min(1).max(128),
  requestedByAdminUserId: z.string().min(1).max(128).nullable(),
  refundedAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const adminOrderJsonFieldSchema = z.record(z.string(), z.unknown());

const adminOrderSummaryResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orderNo: z.string().min(1).max(64),
  machineId: z.string().min(1).max(128),
  machineCode: z.string().min(1).max(64),
  status: orderStatusSchema,
  paymentState: orderPaymentStateSchema,
  fulfillmentState: orderFulfillmentStateSchema,
  totalAmountCents: z.int().nonnegative(),
  currency: z.string().min(1).max(8),
  paidAt: z.iso.datetime().nullable(),
  dispensedAt: z.iso.datetime().nullable(),
  canceledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const adminOrderListItemResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orderNo: z.string().min(1).max(64),
  machineId: z.string().min(1).max(128),
  machineCode: z.string().min(1).max(64).optional(),
  status: orderStatusSchema,
  paymentState: orderPaymentStateSchema.optional(),
  fulfillmentState: orderFulfillmentStateSchema.optional(),
  totalAmountCents: z.int().nonnegative(),
  isDrill: z.boolean().optional(),
  isTest: z.boolean().optional(),
  scenario: z.string().nullable().optional(),
  paidAt: z.iso.datetime().nullable(),
  dispensedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const adminOrderPageResponseSchema = createPageResultSchema(
  adminOrderListItemResponseSchema,
);

const adminOrderItemResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  variantId: z.string().min(1).max(128),
  quantity: z.int().nonnegative(),
  unitPriceCents: z.int().nonnegative(),
  productSnapshot: adminOrderJsonFieldSchema,
});

const adminOrderPaymentResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  paymentNo: z.string().min(1).max(64),
  orderId: z.string().min(1).max(128),
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  amountCents: z.int().nonnegative(),
  expiresAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
  failedReason: z.string().nullable(),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const adminPaymentEventResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  paymentId: z.string().min(1).max(128),
  eventType: z.string().min(1).max(128),
  signatureValid: z.boolean(),
  handledAt: z.iso.datetime().nullable(),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
});

const adminPaymentWebhookAttemptResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  paymentId: z.string().min(1).max(128).nullable(),
  refundId: z.string().min(1).max(128).nullable(),
  eventKind: z.string().min(1).max(32),
  eventType: z.string().max(128).nullable(),
  paymentNo: z.string().max(64).nullable(),
  refundNo: z.string().max(64).nullable(),
  orderNo: z.string().max(64).nullable(),
  signatureValid: z.boolean().nullable(),
  businessValid: z.boolean().nullable(),
  handled: z.boolean(),
  duplicate: z.boolean(),
  failureReason: z.string().max(128).nullable(),
  httpStatus: z.int().nullable(),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const adminPaymentReconciliationAttemptResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  paymentId: z.string().min(1).max(128),
  trigger: z.string().min(1).max(64),
  attemptNo: z.int().positive(),
  status: z.string().min(1).max(64),
  nextRetryAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
});

const adminRefundReconciliationAttemptResponseSchema = z.strictObject({
  trigger: z.string().min(1).max(64),
  attemptNo: z.int().positive(),
  status: z.string().min(1).max(64),
  nextRetryAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
});

const adminPaymentCodeAttemptResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  paymentId: z.string().min(1).max(128),
  orderId: z.string().min(1).max(128),
  attemptNo: z.int().positive(),
  idempotencyKey: z.string().min(1).max(128),
  status: paymentCodeAttemptStatusSchema,
  isActive: z.boolean(),
  amountCents: z.int().positive(),
  currency: z.string().min(1).max(8),
  authCodeMasked: z.string().min(1).max(32),
  source: z.string().min(1).max(64),
  submittedAt: z.iso.datetime().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  reversedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  manualReason: z.string().nullable(),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const adminVendingCommandResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  commandNo: z.string().min(1).max(64),
  orderId: z.string().min(1).max(128),
  machineId: z.string().min(1).max(128),
  machineCode: z.string().min(1).max(64),
  slotId: z.string().min(1).max(128),
  slotCode: z.string().min(1).max(64),
  orderItemId: z.string().min(1).max(128).nullable(),
  commandKind: z.string().min(1).max(64),
  recoveryActionId: z.string().min(1).max(128).nullable(),
  status: vendingCommandStatusSchema,
  sentAt: z.iso.datetime().nullable(),
  ackAt: z.iso.datetime().nullable(),
  resultAt: z.iso.datetime().nullable(),
  retryCount: z.int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const adminInventoryMovementResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  inventoryId: z.string().min(1).max(128),
  deltaQty: z.int(),
  reason: z.string().min(1).max(64),
  orderId: z.string().min(1).max(128).nullable(),
  operatorAdminUserId: z.string().min(1).max(128).nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const adminStockReconciliationLinkResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  caseTable: z.enum([
    "machine_raw_stock_movements",
    "machine_raw_stock_movement_conflicts",
  ]),
  rawMovementId: z.string().min(1).max(128).nullable(),
  machineId: z.string().min(1).max(128),
  movementId: z.string().min(1).max(128),
  status: z.string().min(1).max(64),
  reconciliationReason: z.string().max(128).nullable(),
  platformReviewStatus: z.string().max(64).nullable(),
  saleSafetyBlockerState: z.string().max(64).nullable(),
  saleSafetyBlockerSlotId: z.string().min(1).max(128).nullable(),
  receivedAt: z.iso.datetime(),
});

const adminRefundResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  refundNo: z.string().min(1).max(64),
  paymentId: z.string().min(1).max(128),
  orderId: z.string().min(1).max(128),
  amountCents: z.int().nonnegative(),
  status: refundStatusSchema,
  reason: z.string().min(1).max(1000),
  requestedByAdminUserId: z.string().min(1).max(128).nullable(),
  refundedAt: z.iso.datetime().nullable(),
  reconciliationAttempts: z
    .array(adminRefundReconciliationAttemptResponseSchema)
    .default([]),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const adminMaintenanceWorkOrderLinkResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  workOrderNo: z.string().min(1).max(64),
  machineId: z.string().min(1).max(128).nullable(),
  slotId: z.string().min(1).max(128).nullable(),
  orderId: z.string().min(1).max(128).nullable(),
  commandId: z.string().min(1).max(128).nullable(),
  title: z.string().min(1).max(128),
  priority: z.string().min(1).max(32),
  status: z.string().min(1).max(32),
  assigneeAdminUserId: z.string().min(1).max(128).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

const adminAuditEntryResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  adminUserId: z.string().min(1).max(128).nullable(),
  action: z.string().min(1).max(128),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(128).nullable(),
  ipAddress: z.string().max(64).nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const adminOrderStatusEventResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  fromStatus: orderStatusSchema.nullable(),
  toStatus: orderStatusSchema,
  reason: z.string().min(1).max(128),
  metadata: adminOrderJsonFieldSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const orderInvestigationResponseSchema = z.strictObject({
  order: adminOrderSummaryResponseSchema,
  items: z.array(adminOrderItemResponseSchema),
  payments: z.array(adminOrderPaymentResponseSchema),
  paymentEvents: z.array(adminPaymentEventResponseSchema),
  paymentWebhookAttempts: z.array(adminPaymentWebhookAttemptResponseSchema),
  paymentReconciliationAttempts: z.array(
    adminPaymentReconciliationAttemptResponseSchema,
  ),
  paymentCodeAttempts: z.array(adminPaymentCodeAttemptResponseSchema),
  vendingCommands: z.array(adminVendingCommandResponseSchema),
  fulfillmentProjection: z.strictObject({
    state: orderFulfillmentStateSchema,
    latestCommand: adminVendingCommandResponseSchema.nullable(),
    requiresPhysicalOutcomeConfirmation: z.boolean(),
    availableRecoveryActions: z.array(orderRecoveryActionNameSchema),
  }),
  inventoryMovements: z.array(adminInventoryMovementResponseSchema),
  stockReconciliationLinks: z.array(adminStockReconciliationLinkResponseSchema),
  refunds: z.array(adminRefundResponseSchema),
  maintenanceWorkOrders: z.array(adminMaintenanceWorkOrderLinkResponseSchema),
  adminAuditEntries: z.array(adminAuditEntryResponseSchema),
  orderStatusEvents: z.array(adminOrderStatusEventResponseSchema),
});

export type OrderInvestigationResponse = z.infer<
  typeof orderInvestigationResponseSchema
>;
export type AdminOrderListItemResponse = z.infer<
  typeof adminOrderListItemResponseSchema
>;
export type AdminOrderPageResponse = z.infer<
  typeof adminOrderPageResponseSchema
>;
export type OrderRecoveryActionResponse = z.infer<
  typeof orderRecoveryActionResponseSchema
>;
export type OrderRefundRequestResponse = z.infer<
  typeof orderRefundRequestResponseSchema
>;

export const legacyOrderRecoveryActionSchema = z.object({
  action: z.enum([
    "confirm_dispensed",
    "confirm_not_dispensed",
    "request_refund",
    "compensation_dispense",
  ]),
  note: z.string().trim().min(1).max(500),
});

export type OrderRecoveryAction = z.infer<typeof orderRecoveryActionSchema>;

export const protectedFulfillmentDrillScenarioSchema = z.enum([
  "dispense_failed",
  "unknown_dispense_result",
  "pickup_timeout",
  "maintenance_lock_required",
]);

export type ProtectedFulfillmentDrillScenario = z.infer<
  typeof protectedFulfillmentDrillScenarioSchema
>;

export const createProtectedFulfillmentDrillSchema = z.strictObject({
  machineId: z.uuid(),
  scenario: protectedFulfillmentDrillScenarioSchema,
  reason: z.string().trim().min(1).max(500),
});

export const protectedFulfillmentDrillRecoveryActionSchema = z.strictObject({
  action: z.enum([
    "confirm_dispensed",
    "confirm_not_dispensed",
    "request_refund",
    "compensation_dispense",
  ]),
  reason: z.string().trim().min(1).max(500),
});

export type CreateProtectedFulfillmentDrillInput = z.infer<
  typeof createProtectedFulfillmentDrillSchema
>;
export type ProtectedFulfillmentDrillRecoveryAction = z.infer<
  typeof protectedFulfillmentDrillRecoveryActionSchema
>;

export const machineOrderItemSchema = z.object({
  inventoryId: z.uuid(),
  quantity: z.int().positive(),
  planogramVersion: z.string().min(1).max(128),
  slotId: z.uuid(),
  slotCode: z.string().min(1).max(32),
});

export const machinePaymentProviderCodeSchema = z.enum([
  "mock",
  "wechat_pay",
  "alipay",
]);

const realPaymentProviderCodes = new Set(["wechat_pay", "alipay"]);

export const createMachineOrderSchema = z
  .object({
    machineCode: z.string().min(1).max(64),
    items: z.array(machineOrderItemSchema).min(1).max(10),
    paymentMethod: paymentMethodSchema,
    paymentProviderCode: machinePaymentProviderCodeSchema.optional(),
    profileSnapshot: machineOrderProfileSnapshotSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.paymentMethod === "mock") {
      if (
        value.paymentProviderCode !== undefined &&
        value.paymentProviderCode !== "mock"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["paymentProviderCode"],
          message: "mock payment method can only use mock provider",
        });
      }
      return;
    }

    if (
      value.paymentMethod === "qr_code" ||
      value.paymentMethod === "payment_code"
    ) {
      if (
        value.paymentProviderCode === undefined ||
        (!realPaymentProviderCodes.has(value.paymentProviderCode) &&
          !(
            value.paymentMethod === "payment_code" &&
            value.paymentProviderCode === "mock"
          ))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["paymentProviderCode"],
          message:
            value.paymentMethod === "qr_code"
              ? "qr_code payment method requires alipay or wechat_pay provider"
              : "payment_code payment method requires alipay, wechat_pay, or mock provider",
        });
      }
      return;
    }

    ctx.addIssue({
      code: "custom",
      path: ["paymentMethod"],
      message: `${value.paymentMethod} is not supported by machine order creation`,
    });
  });

export const createMachineOrderResponseSchema = z.object({
  orderId: z.uuid(),
  orderNo: z.string().min(1).max(64),
  paymentId: z.uuid(),
  paymentNo: z.string().min(1).max(64),
  paymentUrl: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  totalAmountCents: z.int().nonnegative(),
  paymentProviderCode: machinePaymentProviderCodeSchema.nullable().optional(),
});

export const machineOrderStatusQuerySchema = z.object({
  machineCode: z.string().min(1).max(64),
});

export const machineOrderStatusNextActionSchema =
  daemonIpcCheckoutFlowActionSchema;

export const machinePaymentOptionKeySchema = z
  .string()
  .regex(
    /^(mock:mock|qr_code:(wechat_pay|alipay)|payment_code:(mock|wechat_pay|alipay))$/,
  );

export const paymentCodeSourceSchema = z.enum([
  "serial_text",
  "tauri_scanner",
  "browser_test",
  "manual_dev",
]);

// This matches the serial-text scanner contract: printable ASCII with an
// optional interior space, but no silently-normalized boundary whitespace.
export const paymentCodeAuthCodeSchema = z
  .string()
  .min(6)
  .max(128)
  .regex(/^[\x20-\x7e]+$/)
  .refine((value) => value === value.trim());

export const paymentCodeSubmitSchema = z.object({
  machineCode: z.string().min(1).max(64),
  authCode: paymentCodeAuthCodeSchema,
  idempotencyKey: z.string().trim().min(8).max(128),
  source: paymentCodeSourceSchema,
  // The daemon event id is correlation evidence, not customer-controlled code.
  // It is only populated by the serial scanner production path.
  scannerEventId: z.string().min(1).max(128).optional(),
  scannerHealth: z
    .object({
      online: z.boolean(),
      adapter: z.string().min(1).max(64),
      port: z.string().max(256).nullable().optional(),
      message: z.string().max(256).nullable().optional(),
    })
    .optional(),
});

export const paymentCodeSubmitResponseSchema = z.object({
  orderNo: z.string().min(1).max(64),
  paymentNo: z.string().min(1).max(64),
  attemptNo: z.int().positive(),
  status: paymentCodeAttemptStatusSchema,
  nextAction: machineOrderStatusNextActionSchema,
  message: z.string().min(1).max(256),
  canRetry: z.boolean(),
  serverTime: z.iso.datetime(),
});

export const machinePaymentOptionSchema = z.object({
  optionKey: machinePaymentOptionKeySchema,
  providerCode: machinePaymentProviderCodeSchema,
  method: paymentMethodSchema,
  displayName: z.string().min(1).max(32),
  description: z.string().min(1).max(128),
  icon: z.enum(["mock", "wechat", "alipay"]),
  recommended: z.boolean().default(false),
  disabled: z.boolean().default(false),
  disabledReason: z.string().max(128).nullable().default(null),
});

export const paymentProviderEnvironmentDiagnosticSchema = z.strictObject({
  environment: z.enum(["sandbox", "production", "mixed", "unavailable"]),
  readiness: z.enum(["ready", "blocked"]),
  errorCategory: z.enum([
    "none",
    "no_enabled_channel",
    "provider_unconfigured",
    "credentials_incomplete",
    "mixed_environment",
  ]),
});

export const machinePaymentOptionsResponseSchema = z.object({
  options: z.array(machinePaymentOptionSchema),
  defaultOptionKey: machinePaymentOptionKeySchema.nullable(),
  defaultProviderCode: machinePaymentProviderCodeSchema.nullable(),
  serverTime: z.iso.datetime(),
});

export type MachinePaymentProviderCode = z.infer<
  typeof machinePaymentProviderCodeSchema
>;
export type CreateMachineOrderResponse = z.infer<
  typeof createMachineOrderResponseSchema
>;
export type MachinePaymentOptionKey = z.infer<
  typeof machinePaymentOptionKeySchema
>;
export type MachinePaymentOption = z.infer<typeof machinePaymentOptionSchema>;
export type PaymentProviderEnvironmentDiagnostic = z.infer<
  typeof paymentProviderEnvironmentDiagnosticSchema
>;
export type MachinePaymentOptionsResponse = z.infer<
  typeof machinePaymentOptionsResponseSchema
>;

export const machineOrderStatusResponseSchema = z.object({
  orderId: z.uuid(),
  orderNo: z.string().min(1).max(64),
  machineCode: z.string().min(1).max(64),
  orderStatus: orderStatusSchema,
  paymentState: orderPaymentStateSchema,
  fulfillmentState: orderFulfillmentStateSchema,
  totalAmountCents: z.int().nonnegative(),
  payment: z.object({
    paymentId: z.string().min(1).max(128),
    paymentNo: z.string().min(1).max(64),
    method: paymentMethodSchema,
    status: paymentStatusSchema,
    paymentUrl: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    paidAt: z.iso.datetime().nullable(),
    failedReason: z.string().nullable(),
    providerCode: machinePaymentProviderCodeSchema.nullable(),
    reconciliation: z
      .object({
        trigger: z.string().min(1).max(64),
        attemptNo: z.int().positive(),
        status: z.string().min(1).max(64),
        providerPaymentStatus: z.string().min(1).max(64).nullable(),
        errorCode: z.string().max(128).nullable(),
        nextRetryAt: z.iso.datetime().nullable(),
        startedAt: z.iso.datetime().nullable(),
        finishedAt: z.iso.datetime().nullable(),
      })
      .nullable()
      .optional(),
  }),
  paymentCodeAttempt: z
    .object({
      attemptNo: z.int().positive(),
      status: paymentCodeAttemptStatusSchema,
      maskedAuthCode: z.string().max(32).nullable(),
      source: paymentCodeSourceSchema.nullable(),
      idempotencyKey: z.string().max(128).nullable(),
      submittedAt: z.iso.datetime().nullable(),
      lastCheckedAt: z.iso.datetime().nullable(),
      canRetry: z.boolean(),
      message: z.string().max(256).nullable(),
    })
    .nullable(),
  vending: z
    .object({
      commandId: z.string().min(1).max(128),
      commandNo: z.string().min(1).max(64),
      status: vendingCommandStatusSchema,
      sentAt: z.iso.datetime().nullable(),
      ackAt: z.iso.datetime().nullable(),
      resultAt: z.iso.datetime().nullable(),
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
          message: z.string().min(1).max(256),
          warningNo: z.int().positive().nullable(),
          reportedAt: z.iso.datetime(),
          remainingSeconds: z.int().nonnegative().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  refund: z
    .object({
      refundNo: z.string().min(1).max(64),
      status: z.enum([
        "created",
        "processing",
        "succeeded",
        "failed",
        "canceled",
      ]),
      amountCents: z.int().nonnegative(),
      reason: z.string(),
      refundedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  nextAction: machineOrderStatusNextActionSchema,
  serverTime: z.iso.datetime(),
});

export type MachineOrderStatusResponse = z.infer<
  typeof machineOrderStatusResponseSchema
>;
export type MachineOrderStatusNextAction = z.infer<
  typeof machineOrderStatusNextActionSchema
>;
export type PaymentCodeSubmitInput = z.infer<typeof paymentCodeSubmitSchema>;
export type PaymentCodeSubmitResponse = z.infer<
  typeof paymentCodeSubmitResponseSchema
>;
export type PaymentCodeSource = z.infer<typeof paymentCodeSourceSchema>;
