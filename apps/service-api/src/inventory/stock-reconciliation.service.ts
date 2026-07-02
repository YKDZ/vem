import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { AuditService } from "../audit/audit.service";
import {
  StockReconciliationRepository,
  type StockReconciliationCaseRow,
  type StockReconciliationPageQuery,
  type StockReconciliationResolveInput,
} from "./stock-reconciliation.repository";

export type {
  StockReconciliationRepository,
  StockReconciliationResolveInput,
} from "./stock-reconciliation.repository";

export type StockReconciliationResolveAction =
  StockReconciliationResolveInput["action"];

export type StockReconciliationResolveRequest = {
  action: StockReconciliationResolveAction;
  note: string;
  clearBlocker?: boolean;
  correctedOnHandQty?: number;
};

@Injectable()
export class StockReconciliationService {
  constructor(
    private readonly repository: StockReconciliationRepository,
    private readonly auditService: AuditService,
  ) {}

  async listCases(query: StockReconciliationPageQuery) {
    const result = await this.repository.listOpenCases(query);
    return {
      ...result,
      items: result.items.map(projectCaseSummary),
    };
  }

  async getCase(id: string) {
    const row = await this.repository.findCaseDetail(id);
    if (!row)
      throw new NotFoundException("Stock reconciliation case not found");
    return projectCaseDetail(row);
  }

  async resolveCase(
    adminUserId: string,
    id: string,
    request: StockReconciliationResolveRequest,
  ) {
    const note = request.note.trim();
    if (!note) {
      throw new BadRequestException("Resolution note is required");
    }
    const correctedOnHandQty = request.correctedOnHandQty;
    if (
      request.action === "manual_correct" &&
      (typeof correctedOnHandQty !== "number" ||
        !Number.isInteger(correctedOnHandQty) ||
        correctedOnHandQty < 0)
    ) {
      throw new BadRequestException(
        "correctedOnHandQty is required for manual correction",
      );
    }

    const resolved = await this.repository.resolveCase(id, {
      action: request.action,
      note,
      clearBlocker: request.clearBlocker,
      correctedOnHandQty,
      adminUserId,
    });
    if (!resolved) {
      throw new NotFoundException("Stock reconciliation case not found");
    }

    await this.auditService.record({
      adminUserId,
      action: `stock_reconciliation.${request.action}`,
      resourceType:
        resolved.case.caseTable === "machine_raw_stock_movement_conflicts"
          ? "machine_raw_stock_movement_conflict"
          : "machine_raw_stock_movement",
      resourceId: resolved.case.id,
      beforeJson: {
        status: resolved.previousCase.status,
        platformReviewStatus: resolved.previousCase.platformReviewStatus,
        saleSafetyBlockerState: resolved.previousCase.saleSafetyBlockerState,
        saleSafetyBlockerSlotId: resolved.previousCase.saleSafetyBlockerSlotId,
        onHandQty: resolved.previousCase.onHandQty,
      },
      afterJson: {
        action: request.action,
        note,
        correctedOnHandQty,
        clearedBlocker: resolved.clearedBlocker,
        inventoryMovement: resolved.inventoryMovement,
      },
    });

    return {
      ...projectCaseDetail(resolved.case),
      resolution: {
        action: request.action,
        note,
        clearedBlocker: resolved.clearedBlocker,
        inventoryMovement: resolved.inventoryMovement,
      },
    };
  }
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
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    reconciliationReason: row.reconciliationReason,
    platformReviewStatus: row.platformReviewStatus,
    slot: projectSlot(row),
    inventory: projectInventory(row),
    blocker: projectBlocker(row),
  };
}

function projectCaseDetail(row: StockReconciliationCaseRow) {
  return {
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
  };
}

function projectSlot(row: StockReconciliationCaseRow) {
  return {
    id: row.saleSafetyBlockerSlotId ?? row.slotId,
    code: row.slotCode,
    status: row.slotStatus,
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
