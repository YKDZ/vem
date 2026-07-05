import { orderRecoveryActions } from "@vem/db";
import {
  type OrderInvestigationResponse,
  type OrderRecoveryAction,
  type OrderRecoveryActionResponse,
  type OrderRefundRequestResponse,
  orderInvestigationResponseSchema,
  orderRecoveryActionResponseSchema,
  orderRefundRequestResponseSchema,
} from "@vem/shared";

type OrderRecoveryActionInsert = typeof orderRecoveryActions.$inferInsert;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;

function toWireValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toWireValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toWireValue(child)]),
    );
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asRecordArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => asRecord(item, `${label}[${index}]`));
}

function mapOrderSummary(row: Record<string, unknown>) {
  return {
    id: row.id,
    orderNo: row.orderNo,
    machineId: row.machineId,
    ...(row.machineCode === undefined ? {} : { machineCode: row.machineCode }),
    status: row.status,
    paymentState: row.paymentState,
    fulfillmentState: row.fulfillmentState,
    totalAmountCents: row.totalAmountCents,
    currency: row.currency,
    paidAt: row.paidAt,
    dispensedAt: row.dispensedAt,
    canceledAt: row.canceledAt,
    createdAt: row.createdAt,
  };
}

function mapOrderItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    variantId: row.variantId,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    productSnapshot: row.productSnapshot,
  };
}

function mapPayment(row: Record<string, unknown>) {
  return {
    id: row.id,
    paymentNo: row.paymentNo,
    orderId: row.orderId,
    method: row.method,
    status: row.status,
    amountCents: row.amountCents,
    providerTradeNo: row.providerTradeNo,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    failedReason: row.failedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPaymentEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    eventType: row.eventType,
    providerEventId: row.providerEventId,
    signatureValid: row.signatureValid,
    handledAt: row.handledAt,
    createdAt: row.createdAt,
  };
}

function mapPaymentWebhookAttempt(row: Record<string, unknown>) {
  return {
    id: row.id,
    providerCode: row.providerCode,
    paymentId: row.paymentId,
    refundId: row.refundId,
    eventKind: row.eventKind,
    eventType: row.eventType,
    providerEventId: row.providerEventId,
    paymentNo: row.paymentNo,
    refundNo: row.refundNo,
    orderNo: row.orderNo,
    signatureValid: row.signatureValid,
    businessValid: row.businessValid,
    handled: row.handled,
    duplicate: row.duplicate,
    failureReason: row.failureReason,
    errorCode: row.errorCode,
    httpStatus: row.httpStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPaymentReconciliationAttempt(row: Record<string, unknown>) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    trigger: row.trigger,
    attemptNo: row.attemptNo,
    status: row.status,
    providerPaymentStatus: row.providerPaymentStatus,
    providerTradeNo: row.providerTradeNo,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    nextRetryAt: row.nextRetryAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

function mapPaymentCodeAttempt(row: Record<string, unknown>) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    orderId: row.orderId,
    attemptNo: row.attemptNo,
    providerPaymentNo: row.providerPaymentNo,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    isActive: row.isActive,
    amountCents: row.amountCents,
    currency: row.currency,
    authCodeMasked: row.authCodeMasked,
    source: row.source,
    providerTradeNo: row.providerTradeNo,
    providerStatus: row.providerStatus,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    submittedAt: row.submittedAt,
    lastCheckedAt: row.lastCheckedAt,
    reversedAt: row.reversedAt,
    finishedAt: row.finishedAt,
    manualReason: row.manualReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapVendingCommand(row: Record<string, unknown>) {
  return {
    id: row.id,
    commandNo: row.commandNo,
    orderId: row.orderId,
    machineId: row.machineId,
    ...(row.machineCode === undefined ? {} : { machineCode: row.machineCode }),
    slotId: row.slotId,
    ...(row.slotCode === undefined ? {} : { slotCode: row.slotCode }),
    orderItemId: row.orderItemId,
    commandKind: row.commandKind,
    recoveryActionId: row.recoveryActionId,
    status: row.status,
    sentAt: row.sentAt,
    ackAt: row.ackAt,
    resultAt: row.resultAt,
    retryCount: row.retryCount,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapInventoryMovement(row: Record<string, unknown>) {
  return {
    id: row.id,
    inventoryId: row.inventoryId,
    deltaQty: row.deltaQty,
    reason: row.reason,
    orderId: row.orderId,
    operatorAdminUserId: row.operatorAdminUserId,
    note: row.note,
    createdAt: row.createdAt,
  };
}

function mapStockReconciliationLink(row: Record<string, unknown>) {
  return {
    id: row.id,
    caseTable: row.caseTable,
    rawMovementId: row.rawMovementId,
    machineId: row.machineId,
    movementId: row.movementId,
    status: row.status,
    reconciliationReason: row.reconciliationReason,
    platformReviewStatus: row.platformReviewStatus,
    saleSafetyBlockerState: row.saleSafetyBlockerState,
    saleSafetyBlockerSlotId: row.saleSafetyBlockerSlotId,
    receivedAt: row.receivedAt,
  };
}

function mapRefund(row: Record<string, unknown>) {
  return {
    id: row.id,
    refundNo: row.refundNo,
    paymentId: row.paymentId,
    orderId: row.orderId,
    amountCents: row.amountCents,
    status: row.status,
    providerRefundNo: row.providerRefundNo,
    reason: row.reason,
    requestedByAdminUserId: row.requestedByAdminUserId,
    refundedAt: row.refundedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMaintenanceWorkOrderLink(row: Record<string, unknown>) {
  return {
    id: row.id,
    workOrderNo: row.workOrderNo,
    machineId: row.machineId,
    slotId: row.slotId,
    orderId: row.orderId,
    commandId: row.commandId,
    title: row.title,
    priority: row.priority,
    status: row.status,
    assigneeAdminUserId: row.assigneeAdminUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
  };
}

function mapAuditEntry(row: Record<string, unknown>) {
  return {
    id: row.id,
    adminUserId: row.adminUserId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  };
}

function mapOrderStatusEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export function mapOrderRecoveryActionDtoToInsert(input: {
  orderId: string;
  commandId: string;
  adminUserId: string;
  body: OrderRecoveryAction;
}): OrderRecoveryActionInsert {
  const dto = {
    action: input.body.action,
    note: input.body.note,
  } satisfies ContractFieldCoverage<OrderRecoveryAction>;

  return {
    orderId: input.orderId,
    commandId: input.commandId,
    action: dto.action,
    status: "started",
    note: dto.note.trim(),
    requestedByAdminUserId: input.adminUserId,
  } satisfies OrderRecoveryActionInsert;
}

export function toOrderRecoveryActionResponse(input: {
  action: OrderRecoveryAction["action"];
  recoveryActionId: string;
  commandId: string;
  commandNo?: string;
  status: string;
}): OrderRecoveryActionResponse {
  const response = {
    action: input.action,
    recoveryActionId: input.recoveryActionId,
    commandId: input.commandId,
    ...(input.commandNo === undefined ? {} : { commandNo: input.commandNo }),
    status: input.status,
  } satisfies OrderRecoveryActionResponse;
  return orderRecoveryActionResponseSchema.parse(response);
}

export function toOrderRefundRequestResponse(
  refund: Record<string, unknown>,
): OrderRefundRequestResponse {
  return orderRefundRequestResponseSchema.parse(toWireValue(refund));
}

export function toOrderInvestigationResponse(
  investigation: Record<string, unknown>,
): OrderInvestigationResponse {
  const fulfillmentProjection = asRecord(
    investigation.fulfillmentProjection,
    "fulfillmentProjection",
  );
  const latestCommand =
    fulfillmentProjection.latestCommand === null
      ? null
      : mapVendingCommand(
          asRecord(
            fulfillmentProjection.latestCommand,
            "fulfillmentProjection.latestCommand",
          ),
        );
  const response = {
    order: mapOrderSummary(asRecord(investigation.order, "order")),
    items: asRecordArray(investigation.items, "items").map(mapOrderItem),
    payments: asRecordArray(investigation.payments, "payments").map(mapPayment),
    paymentEvents: asRecordArray(
      investigation.paymentEvents,
      "paymentEvents",
    ).map(mapPaymentEvent),
    paymentWebhookAttempts: asRecordArray(
      investigation.paymentWebhookAttempts,
      "paymentWebhookAttempts",
    ).map(mapPaymentWebhookAttempt),
    paymentReconciliationAttempts: asRecordArray(
      investigation.paymentReconciliationAttempts,
      "paymentReconciliationAttempts",
    ).map(mapPaymentReconciliationAttempt),
    paymentCodeAttempts: asRecordArray(
      investigation.paymentCodeAttempts,
      "paymentCodeAttempts",
    ).map(mapPaymentCodeAttempt),
    vendingCommands: asRecordArray(
      investigation.vendingCommands,
      "vendingCommands",
    ).map(mapVendingCommand),
    fulfillmentProjection: {
      state: fulfillmentProjection.state,
      latestCommand,
      requiresPhysicalOutcomeConfirmation:
        fulfillmentProjection.requiresPhysicalOutcomeConfirmation,
      availableRecoveryActions: fulfillmentProjection.availableRecoveryActions,
    },
    inventoryMovements: asRecordArray(
      investigation.inventoryMovements,
      "inventoryMovements",
    ).map(mapInventoryMovement),
    stockReconciliationLinks: asRecordArray(
      investigation.stockReconciliationLinks,
      "stockReconciliationLinks",
    ).map(mapStockReconciliationLink),
    refunds: asRecordArray(investigation.refunds, "refunds").map(mapRefund),
    maintenanceWorkOrders: asRecordArray(
      investigation.maintenanceWorkOrders,
      "maintenanceWorkOrders",
    ).map(mapMaintenanceWorkOrderLink),
    adminAuditEntries: asRecordArray(
      investigation.adminAuditEntries,
      "adminAuditEntries",
    ).map(mapAuditEntry),
    orderStatusEvents: asRecordArray(
      investigation.orderStatusEvents,
      "orderStatusEvents",
    ).map(mapOrderStatusEvent),
  };
  return orderInvestigationResponseSchema.parse(toWireValue(response));
}
