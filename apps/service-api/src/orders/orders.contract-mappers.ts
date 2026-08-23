import { orderRecoveryActions } from "@vem/db";
import {
  type OrderDetailResponse,
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
  return Object.fromEntries(Object.entries(value));
}

function asRecordArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => asRecord(item, `${label}[${index}]`));
}

function protectedDiagnostics(
  row: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
  );
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
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    failedReason: row.failedReason,
    protectedDiagnostics: protectedDiagnostics(row, ["providerTradeNo"]),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPaymentEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    eventType: row.eventType,
    signatureValid: row.signatureValid,
    handledAt: row.handledAt,
    protectedDiagnostics: protectedDiagnostics(row, ["providerEventId"]),
    createdAt: row.createdAt,
  };
}

function mapPaymentWebhookAttempt(row: Record<string, unknown>) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    refundId: row.refundId,
    eventKind: row.eventKind,
    eventType: row.eventType,
    paymentNo: row.paymentNo,
    refundNo: row.refundNo,
    orderNo: row.orderNo,
    signatureValid: row.signatureValid,
    businessValid: row.businessValid,
    handled: row.handled,
    duplicate: row.duplicate,
    failureReason: row.failureReason,
    httpStatus: row.httpStatus,
    protectedDiagnostics: protectedDiagnostics(row, [
      "providerCode",
      "providerEventId",
      "errorCode",
    ]),
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
    nextRetryAt: row.nextRetryAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    protectedDiagnostics: protectedDiagnostics(row, [
      "providerPaymentStatus",
      "providerTradeNo",
      "errorCode",
      "errorMessage",
    ]),
    createdAt: row.createdAt,
  };
}

function mapPaymentCodeAttempt(row: Record<string, unknown>) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    orderId: row.orderId,
    attemptNo: row.attemptNo,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    isActive: row.isActive,
    amountCents: row.amountCents,
    currency: row.currency,
    authCodeMasked: row.authCodeMasked,
    source: row.source,
    submittedAt: row.submittedAt,
    lastCheckedAt: row.lastCheckedAt,
    reversedAt: row.reversedAt,
    finishedAt: row.finishedAt,
    manualReason: row.manualReason,
    protectedDiagnostics: protectedDiagnostics(row, [
      "providerPaymentNo",
      "providerTradeNo",
      "providerStatus",
      "failureCode",
      "failureMessage",
    ]),
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
    ...(row.slotDisplayLabel === undefined
      ? {}
      : { slotDisplayLabel: row.slotDisplayLabel }),
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
  const reconciliationAttempts = Array.isArray(row.reconciliationAttempts)
    ? row.reconciliationAttempts.map((attempt) => {
        const record = asRecord(attempt, "refund.reconciliationAttempt");
        return {
          trigger: record.trigger,
          attemptNo: record.attemptNo,
          status: record.status,
          nextRetryAt: record.nextRetryAt,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          protectedDiagnostics: protectedDiagnostics(record, [
            "providerRefundStatus",
            "providerRefundNo",
            "errorCode",
            "errorMessage",
          ]),
          createdAt: record.createdAt,
        };
      })
    : [];
  return {
    id: row.id,
    refundNo: row.refundNo,
    paymentId: row.paymentId,
    orderId: row.orderId,
    amountCents: row.amountCents,
    status: row.status,
    reason: row.reason,
    requestedByAdminUserId: row.requestedByAdminUserId,
    refundedAt: row.refundedAt,
    reconciliationAttempts,
    protectedDiagnostics: protectedDiagnostics(row, ["providerRefundNo"]),
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

type DetailOrderRow = {
  id: string;
  orderNo: string;
  machineId: string;
  machineCode: string;
  status: OrderDetailResponse["order"]["status"];
  paymentState: OrderDetailResponse["order"]["paymentState"];
  fulfillmentState: OrderDetailResponse["order"]["fulfillmentState"];
  totalAmountCents: number;
  currency: string;
  paidAt: Date | null;
  dispensedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
};

type DetailItemRow = {
  id: string;
  variantId: string;
  quantity: number;
  unitPriceCents: number;
  productSnapshot: Record<string, unknown>;
};

type DetailPaymentRow = {
  id: string;
  paymentNo: string;
  orderId: string;
  method: OrderDetailResponse["payments"][number]["method"];
  status: OrderDetailResponse["payments"][number]["status"];
  amountCents: number;
  providerTradeNo: string | null;
  paymentUrl: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  failedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DetailPaymentEventRow = {
  id: string;
  paymentId: string;
  eventType: string;
  providerEventId: string | null;
  signatureValid: boolean;
  handledAt: Date | null;
  createdAt: Date;
};

type DetailVendingCommandRow = {
  id: string;
  commandNo: string;
  orderId: string;
  machineId: string;
  slotId: string;
  orderItemId: string | null;
  commandKind: string;
  recoveryActionId: string | null;
  status: OrderDetailResponse["vendingCommands"][number]["status"];
  sentAt: Date | null;
  ackAt: Date | null;
  resultAt: Date | null;
  retryCount: number;
  lastError: string | null;
  createdAt: Date;
};

type DetailInventoryMovementRow = {
  id: string;
  inventoryId: string;
  deltaQty: number;
  reason: string;
  orderId: string | null;
  operatorAdminUserId: string | null;
  note: string | null;
  createdAt: Date;
};

type DetailOrderStatusEventRow = {
  id: string;
  fromStatus: OrderDetailResponse["orderStatusEvents"][number]["fromStatus"];
  toStatus: OrderDetailResponse["orderStatusEvents"][number]["toStatus"];
  reason: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

export function toOrderDetailResponse(input: {
  order: DetailOrderRow;
  items: DetailItemRow[];
  payments: DetailPaymentRow[];
  paymentEvents: DetailPaymentEventRow[];
  vendingCommands: DetailVendingCommandRow[];
  inventoryMovements: DetailInventoryMovementRow[];
  orderStatusEvents: DetailOrderStatusEventRow[];
}): OrderDetailResponse {
  return {
    order: {
      id: input.order.id,
      orderNo: input.order.orderNo,
      machineId: input.order.machineId,
      machineCode: input.order.machineCode,
      status: input.order.status,
      paymentState: input.order.paymentState,
      fulfillmentState: input.order.fulfillmentState,
      totalAmountCents: input.order.totalAmountCents,
      currency: input.order.currency,
      paidAt: toIsoOrNull(input.order.paidAt),
      dispensedAt: toIsoOrNull(input.order.dispensedAt),
      canceledAt: toIsoOrNull(input.order.canceledAt),
      createdAt: toIso(input.order.createdAt),
    },
    items: input.items.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      productSnapshot: item.productSnapshot,
    })),
    payments: input.payments.map((payment) => ({
      id: payment.id,
      paymentNo: payment.paymentNo,
      orderId: payment.orderId,
      method: payment.method,
      status: payment.status,
      amountCents: payment.amountCents,
      providerTradeNo: payment.providerTradeNo,
      paymentUrl: payment.paymentUrl,
      expiresAt: toIsoOrNull(payment.expiresAt),
      paidAt: toIsoOrNull(payment.paidAt),
      failedReason: payment.failedReason,
      createdAt: toIso(payment.createdAt),
      updatedAt: toIso(payment.updatedAt),
    })),
    paymentEvents: input.paymentEvents.map((event) => ({
      id: event.id,
      paymentId: event.paymentId,
      eventType: event.eventType,
      providerEventId: event.providerEventId,
      signatureValid: event.signatureValid,
      handledAt: toIsoOrNull(event.handledAt),
      createdAt: toIso(event.createdAt),
    })),
    vendingCommands: input.vendingCommands.map((command) => ({
      id: command.id,
      commandNo: command.commandNo,
      orderId: command.orderId,
      machineId: command.machineId,
      slotId: command.slotId,
      orderItemId: command.orderItemId,
      commandKind: command.commandKind,
      recoveryActionId: command.recoveryActionId,
      status: command.status,
      sentAt: toIsoOrNull(command.sentAt),
      ackAt: toIsoOrNull(command.ackAt),
      resultAt: toIsoOrNull(command.resultAt),
      retryCount: command.retryCount,
      lastError: command.lastError,
      createdAt: toIso(command.createdAt),
    })),
    inventoryMovements: input.inventoryMovements.map((movement) => ({
      id: movement.id,
      inventoryId: movement.inventoryId,
      deltaQty: movement.deltaQty,
      reason: movement.reason,
      orderId: movement.orderId,
      operatorAdminUserId: movement.operatorAdminUserId,
      note: movement.note,
      createdAt: toIso(movement.createdAt),
    })),
    orderStatusEvents: input.orderStatusEvents.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reason: event.reason,
      metadata: event.metadata,
      createdAt: toIso(event.createdAt),
    })),
  };
}
