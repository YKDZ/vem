import {
  adminStockReconciliationCaseDetailResponseSchema,
  adminStockReconciliationCaseSummaryResponseSchema,
  inventoryMovementReasonSchema,
  type AdminStockReconciliationCaseDetailResponse,
  type AdminStockReconciliationCaseSummaryResponse,
  type AdminStockReconciliationResolveRequest,
} from "@vem/shared";

import type {
  StockReconciliationCaseRow,
  StockReconciliationResolveInput,
  StockReconciliationResolveResult,
} from "./stock-reconciliation.repository";

type StockReconciliationResolutionResponse = NonNullable<
  AdminStockReconciliationCaseDetailResponse["resolution"]
>;
type AdminStockReconciliationSlotStatus =
  AdminStockReconciliationCaseSummaryResponse["slot"]["status"];

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function saleEligible(row: StockReconciliationCaseRow): boolean {
  return (
    slotSalesState(row) === "sale_ready" &&
    Math.max((row.onHandQty ?? 0) - (row.reservedQty ?? 0), 0) > 0
  );
}

function slotSalesState(row: StockReconciliationCaseRow): string {
  if (row.saleSafetyBlockerState) return row.saleSafetyBlockerState;
  if (row.slotStatus === "faulted") return "frozen";
  return Math.max((row.onHandQty ?? 0) - (row.reservedQty ?? 0), 0) > 0
    ? "sale_ready"
    : "sold_out";
}

function saleEligibilityReason(row: StockReconciliationCaseRow): string | null {
  if (row.reconciliationReason) return row.reconciliationReason;
  if (row.slotStatus === "faulted") return "slot_faulted";
  return null;
}

function toSlotStatus(
  value: string | null,
): AdminStockReconciliationSlotStatus {
  if (value === "enabled" || value === "disabled" || value === "faulted") {
    return value;
  }
  return null;
}

function projectSlot(row: StockReconciliationCaseRow) {
  return {
    id: row.saleSafetyBlockerSlotId ?? row.slotId,
    code: row.slotCode,
    status: toSlotStatus(row.slotStatus),
    saleEligibility: {
      eligible: saleEligible(row),
      slotSalesState: slotSalesState(row),
      reason: saleEligibilityReason(row),
    },
  };
}

function projectInventory(row: StockReconciliationCaseRow) {
  if (!row.inventoryId) return null;
  const onHandQty = row.onHandQty ?? 0;
  const reservedQty = row.reservedQty ?? 0;
  return {
    id: row.inventoryId,
    productName: row.productName,
    sku: row.sku,
    onHandQty,
    reservedQty,
    saleableQty: saleEligible(row) ? Math.max(onHandQty - reservedQty, 0) : 0,
  };
}

function projectBlocker(row: StockReconciliationCaseRow) {
  if (!row.saleSafetyBlockerState) return null;
  return {
    state: row.saleSafetyBlockerState,
    reason: row.reconciliationReason,
    linkedCaseId: row.id,
    linkedOrderId: row.linkedOrderId,
    linkedOrderNo: row.linkedOrderNo,
    linkedCommandId: row.linkedCommandId,
    linkedCommandNo: row.linkedCommandNo,
  };
}

function projectCaseSummary(row: StockReconciliationCaseRow) {
  return {
    id: row.id,
    caseTable: row.caseTable,
    rawMovementId: row.rawMovementId,
    machineId: row.machineId,
    machineCode: row.machineCode,
    movementId: row.movementId,
    movementType: row.movementType,
    quantity: row.quantity,
    source: row.source,
    attributedTo: row.attributedTo,
    occurredAt: toIsoString(row.occurredAt),
    receivedAt: toIsoString(row.receivedAt),
    reconciliationReason: row.reconciliationReason,
    platformReviewStatus: row.platformReviewStatus,
    slot: projectSlot(row),
    inventory: projectInventory(row),
    blocker: projectBlocker(row),
  };
}

export function mapStockReconciliationResolveDtoToRepositoryInput(
  adminUserId: string,
  input: AdminStockReconciliationResolveRequest,
): StockReconciliationResolveInput {
  if (input.action === "manual_correct") {
    const dto = {
      action: input.action,
      note: input.note,
      clearBlocker: input.clearBlocker,
      correctedOnHandQty: input.correctedOnHandQty,
    } satisfies Extract<
      AdminStockReconciliationResolveRequest,
      { action: "manual_correct" }
    >;

    return {
      action: dto.action,
      note: dto.note.trim(),
      clearBlocker: dto.clearBlocker,
      correctedOnHandQty: dto.correctedOnHandQty,
      adminUserId,
    } satisfies StockReconciliationResolveInput;
  }

  const dto = {
    action: input.action,
    note: input.note,
    clearBlocker: input.clearBlocker,
  } satisfies Exclude<
    AdminStockReconciliationResolveRequest,
    { action: "manual_correct" }
  >;

  return {
    action: dto.action,
    note: dto.note.trim(),
    clearBlocker: dto.clearBlocker,
    correctedOnHandQty: undefined,
    adminUserId,
  } satisfies StockReconciliationResolveInput;
}

export function toAdminStockReconciliationCaseSummaryResponse(
  row: StockReconciliationCaseRow,
): AdminStockReconciliationCaseSummaryResponse {
  const response = projectCaseSummary(
    row,
  ) satisfies AdminStockReconciliationCaseSummaryResponse;
  return adminStockReconciliationCaseSummaryResponseSchema.parse(response);
}

export function toAdminStockReconciliationCaseDetailResponse(
  row: StockReconciliationCaseRow,
  resolution?: StockReconciliationResolutionResponse,
): AdminStockReconciliationCaseDetailResponse {
  const response = {
    ...projectCaseSummary(row),
    planogramVersion: row.planogramVersion,
    evidence: {
      rawPayload: row.payloadJson,
      normalizedPayload: row.normalizedJson,
      inventory: projectInventory(row),
      linkedOrder: row.linkedOrderId
        ? { id: row.linkedOrderId, orderNo: row.linkedOrderNo }
        : null,
      linkedCommand: row.linkedCommandId
        ? { id: row.linkedCommandId, commandNo: row.linkedCommandNo }
        : null,
    },
    ...(resolution === undefined ? {} : { resolution }),
  } satisfies AdminStockReconciliationCaseDetailResponse;
  return adminStockReconciliationCaseDetailResponseSchema.parse(response);
}

export function toStockReconciliationResolutionResponse(
  result: Pick<
    StockReconciliationResolveResult,
    "clearedBlocker" | "inventoryMovement"
  >,
  input: Pick<StockReconciliationResolveInput, "action" | "note">,
): StockReconciliationResolutionResponse {
  const inventoryMovement = result.inventoryMovement
    ? {
        ...result.inventoryMovement,
        reason: inventoryMovementReasonSchema.parse(
          result.inventoryMovement.reason,
        ),
      }
    : null;
  const response = {
    action: input.action,
    note: input.note,
    clearedBlocker: result.clearedBlocker,
    inventoryMovement,
  } satisfies StockReconciliationResolutionResponse;
  return response;
}
