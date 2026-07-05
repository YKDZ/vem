import { describe, expect, it } from "vitest";

import {
  mapStockReconciliationResolveDtoToRepositoryInput,
  toAdminStockReconciliationCaseDetailResponse,
  toAdminStockReconciliationCaseSummaryResponse,
} from "./stock-reconciliation.contract-mappers";
import { type StockReconciliationCaseRow } from "./stock-reconciliation.repository";

function makeCaseRow(): StockReconciliationCaseRow {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    caseTable: "machine_raw_stock_movements",
    rawMovementId: null,
    machineId: "550e8400-e29b-41d4-a716-446655440001",
    machineCode: "M001",
    movementId: "MOVE-1",
    planogramVersion: "PLAN-1",
    slotId: "550e8400-e29b-41d4-a716-446655440002",
    slotCode: "A1",
    movementType: "stock_count_correction",
    quantity: 4,
    beforeQuantity: 6,
    afterQuantity: 4,
    source: "local_maintenance",
    attributedTo: null,
    occurredAt: new Date("2026-06-01T00:00:00.000Z"),
    receivedAt: new Date("2026-06-01T00:01:00.000Z"),
    status: "reconciliation",
    reconciliationReason: "weak_attribution",
    platformReviewStatus: "open",
    saleSafetyBlockerState: "needs_platform_review",
    saleSafetyBlockerSlotId: "550e8400-e29b-41d4-a716-446655440002",
    payloadJson: { movementId: "MOVE-1" },
    normalizedJson: { movementId: "MOVE-1" },
    inventoryId: null,
    productName: null,
    sku: null,
    onHandQty: null,
    reservedQty: null,
    slotStatus: "enabled",
    linkedOrderId: null,
    linkedOrderNo: null,
    linkedCommandId: null,
    linkedCommandNo: null,
  };
}

describe("stock reconciliation contract mappers", () => {
  it("maps resolution DTO variants to repository input", () => {
    expect(
      mapStockReconciliationResolveDtoToRepositoryInput("admin-1", {
        action: "manual_correct",
        note: " counted on site ",
        correctedOnHandQty: 4,
        clearBlocker: true,
      }),
    ).toEqual({
      action: "manual_correct",
      note: "counted on site",
      correctedOnHandQty: 4,
      clearBlocker: true,
      adminUserId: "admin-1",
    });
    expect(
      mapStockReconciliationResolveDtoToRepositoryInput("admin-1", {
        action: "reject_machine_stock",
        note: "payload conflict",
      }),
    ).toEqual({
      action: "reject_machine_stock",
      note: "payload conflict",
      correctedOnHandQty: undefined,
      clearBlocker: undefined,
      adminUserId: "admin-1",
    });
  });

  it("assembles summary and detail Admin API responses with nullable evidence", () => {
    const row = makeCaseRow();
    const summary = toAdminStockReconciliationCaseSummaryResponse(row);
    expect(summary.inventory).toBeNull();
    expect(summary.blocker?.linkedOrderId).toBeNull();

    const detail = toAdminStockReconciliationCaseDetailResponse(row, {
      action: "reject_machine_stock",
      note: "payload conflict",
      clearedBlocker: false,
      inventoryMovement: null,
    });
    expect(detail.evidence.inventory).toBeNull();
    expect(detail.resolution?.inventoryMovement).toBeNull();
    expect(detail.occurredAt).toBe("2026-06-01T00:00:00.000Z");
  });
});
