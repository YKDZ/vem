import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  DrizzleStockReconciliationRepository,
  type StockReconciliationCaseRow,
} from "./stock-reconciliation.repository";

function makeCase(
  overrides: Partial<StockReconciliationCaseRow> = {},
): StockReconciliationCaseRow {
  return {
    id: "raw-1",
    caseTable: "machine_raw_stock_movements",
    rawMovementId: null,
    machineId: "machine-1",
    machineCode: "M001",
    movementId: "MOVE-1",
    planogramVersion: "PLAN-1",
    slotId: "slot-1",
    slotCode: "A1",
    movementType: "stock_count_correction",
    quantity: 4,
    beforeQuantity: 6,
    afterQuantity: 4,
    source: "local_maintenance",
    attributedTo: "operator",
    occurredAt: new Date("2026-06-04T04:00:00.000Z"),
    receivedAt: new Date("2026-06-04T04:01:00.000Z"),
    status: "reconciliation",
    reconciliationReason: "weak_attribution",
    platformReviewStatus: "open",
    saleSafetyBlockerState: "needs_platform_review",
    saleSafetyBlockerSlotId: "slot-1",
    payloadJson: { movementId: "MOVE-1", afterQuantity: 4 },
    normalizedJson: { movementId: "MOVE-1" },
    inventoryId: "inventory-1",
    productName: "测试商品",
    sku: "SKU-1",
    onHandQty: 6,
    reservedQty: 0,
    slotStatus: "faulted",
    linkedOrderId: "order-1",
    linkedOrderNo: "ORD-1",
    linkedCommandId: "command-1",
    linkedCommandNo: "VCMD-1",
    ...overrides,
  };
}

function makeRepository() {
  const tx = {
    execute: vi.fn(),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => await fn(tx)),
  };
  const repository = new DrizzleStockReconciliationRepository(db as never);
  return { repository, db, tx };
}

describe("DrizzleStockReconciliationRepository", () => {
  it("rejects a retired-source planned refill without changing platform inventory", async () => {
    const { repository, tx } = makeRepository();
    const openCase = makeCase({
      movementType: "planned_refill",
      source: "field_service",
      afterQuantity: 9,
      onHandQty: 6,
    });
    const findCaseById = vi
      .fn()
      .mockResolvedValueOnce(openCase)
      .mockResolvedValueOnce({
        ...openCase,
        status: "rejected",
        platformReviewStatus: "resolved",
      });
    Object.assign(repository, { findCaseById });
    tx.execute.mockResolvedValueOnce({ rowCount: 1 });

    const result = await repository.resolveCase("raw-1", {
      action: "reject_machine_stock",
      note: "retired refill source is not physical-stock evidence",
      clearBlocker: false,
      adminUserId: "admin-1",
    });

    expect(result?.case.status).toBe("rejected");
    expect(result?.inventoryMovement).toBeNull();
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rejects manual correction below reserved quantity before writing", async () => {
    const { repository, tx } = makeRepository();
    const findCaseById = vi.fn().mockResolvedValueOnce(
      makeCase({
        onHandQty: 6,
        reservedQty: 5,
      }),
    );
    Object.assign(repository, { findCaseById });

    await expect(
      repository.resolveCase("raw-1", {
        action: "manual_correct",
        correctedOnHandQty: 4,
        note: "counted on site",
        clearBlocker: true,
        adminUserId: "admin-1",
      }),
    ).rejects.toThrow(ConflictException);

    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("does not write movement or clear blockers when conditional resolve loses the race", async () => {
    const { repository, tx } = makeRepository();
    const findCaseById = vi.fn().mockResolvedValueOnce(makeCase());
    const clearResolvedCaseBlocker = vi.fn().mockResolvedValue(true);
    Object.assign(repository, { findCaseById, clearResolvedCaseBlocker });
    tx.execute.mockResolvedValueOnce({ rowCount: 0 });

    const result = await repository.resolveCase("raw-1", {
      action: "reject_machine_stock",
      note: "duplicate resolution",
      clearBlocker: true,
      adminUserId: "admin-1",
    });

    expect(result).toBeNull();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(clearResolvedCaseBlocker).not.toHaveBeenCalled();
  });

  it("records a separate adjustment while retaining the previous case for audit", async () => {
    const { repository, tx } = makeRepository();
    const openCase = makeCase();
    const resolvedCase = makeCase({
      status: "accepted",
      platformReviewStatus: "resolved",
      saleSafetyBlockerState: null,
    });
    const findCaseById = vi
      .fn()
      .mockResolvedValueOnce(openCase)
      .mockResolvedValueOnce(resolvedCase);
    const clearResolvedCaseBlocker = vi.fn().mockResolvedValue(false);
    Object.assign(repository, { findCaseById, clearResolvedCaseBlocker });
    tx.execute
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await repository.resolveCase("raw-1", {
      action: "manual_correct",
      correctedOnHandQty: 4,
      note: "counted on site",
      clearBlocker: false,
      adminUserId: "admin-1",
    });

    expect(result?.case.platformReviewStatus).toBe("resolved");
    expect(result?.previousCase.platformReviewStatus).toBe("open");
    expect(result?.inventoryMovement).toMatchObject({
      inventoryId: "inventory-1",
      deltaQty: -2,
      reason: "adjust",
    });
  });
});
