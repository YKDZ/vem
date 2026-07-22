import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuditService } from "../audit/audit.service";

import {
  StockReconciliationService,
  type StockReconciliationRepository,
} from "./stock-reconciliation.service";

const RAW_CASE_ID = "550e8400-e29b-41d4-a716-446655440000";
const MACHINE_ID = "550e8400-e29b-41d4-a716-446655440001";
const SLOT_ID = "550e8400-e29b-41d4-a716-446655440002";
const INVENTORY_ID = "550e8400-e29b-41d4-a716-446655440003";
const ORDER_ID = "550e8400-e29b-41d4-a716-446655440004";
const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440005";
const CONFLICT_CASE_ID = "550e8400-e29b-41d4-a716-446655440006";

function makeOpenCase() {
  return {
    id: RAW_CASE_ID,
    caseTable: "machine_raw_stock_movements" as const,
    rawMovementId: null,
    machineId: MACHINE_ID,
    machineCode: "M001",
    movementId: "MOVE-1",
    planogramVersion: "PLAN-1",
    slotId: SLOT_ID,
    movementType: "stock_count_correction",
    quantity: 4,
    beforeQuantity: 6,
    afterQuantity: 4,
    source: "local_maintenance",
    attributedTo: "front-panel",
    occurredAt: new Date("2026-06-04T04:00:00.000Z"),
    receivedAt: new Date("2026-06-04T04:01:00.000Z"),
    status: "reconciliation",
    reconciliationReason: "weak_attribution",
    platformReviewStatus: "open",
    saleSafetyBlockerState: "needs_platform_review",
    saleSafetyBlockerSlotId: SLOT_ID,
    payloadJson: {
      movementId: "MOVE-1",
      beforeQuantity: 6,
      afterQuantity: 4,
      orderContext: {
        orderNo: "ORD-1",
        vendingCommandNo: "VCMD-1",
      },
    },
    normalizedJson: { movementId: "MOVE-1" },
    inventoryId: INVENTORY_ID,
    productName: "测试商品",
    sku: "SKU-1",
    onHandQty: 6,
    reservedQty: 1,
    slotStatus: "enabled",
    linkedOrderId: ORDER_ID,
    linkedOrderNo: "ORD-1",
    linkedCommandId: COMMAND_ID,
    linkedCommandNo: "VCMD-1",
  };
}

function makeService(overrides: Partial<StockReconciliationRepository> = {}) {
  const repository: StockReconciliationRepository = {
    listOpenCases: vi.fn().mockResolvedValue({
      items: [makeOpenCase()],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    findCaseDetail: vi.fn().mockResolvedValue(makeOpenCase()),
    resolveCase: vi.fn(),
    ...overrides,
  };
  const auditService = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;
  return {
    service: new StockReconciliationService(repository, auditService),
    repository,
    auditService,
  };
}

describe("StockReconciliationService", () => {
  it("lists open stock reconciliation cases with blocker and sale eligibility evidence", async () => {
    const { service, repository } = makeService();

    const result = await service.listCases({ page: 1, pageSize: 20 });

    expect(repository.listOpenCases).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
    });
    expect(result).toMatchObject({
      total: 1,
      items: [
        {
          id: RAW_CASE_ID,
          machineCode: "M001",
          movementId: "MOVE-1",
          slot: {
            id: SLOT_ID,
            code: null,
            status: "enabled",
            saleEligibility: {
              eligible: false,
              slotSalesState: "needs_platform_review",
              reason: "weak_attribution",
            },
          },
          blocker: {
            state: "needs_platform_review",
            reason: "weak_attribution",
            linkedCaseId: RAW_CASE_ID,
            linkedOrderNo: "ORD-1",
            linkedCommandNo: "VCMD-1",
          },
        },
      ],
    });
  });

  it("opens detail evidence for one stock reconciliation case", async () => {
    const { service } = makeService();

    const detail = await service.getCase(RAW_CASE_ID);

    expect(detail).toMatchObject({
      id: RAW_CASE_ID,
      evidence: {
        rawPayload: {
          movementId: "MOVE-1",
          beforeQuantity: 6,
          afterQuantity: 4,
        },
        normalizedPayload: { movementId: "MOVE-1" },
        inventory: {
          id: INVENTORY_ID,
          onHandQty: 6,
          reservedQty: 1,
          saleableQty: 0,
        },
      },
    });
  });

  it("requires a note when resolving stock reconciliation", async () => {
    const { service } = makeService();

    await expect(
      service.resolveCase("admin-1", RAW_CASE_ID, {
        action: "reject_machine_stock",
        note: " ",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("writes a separate adjustment and admin audit for manual correction", async () => {
    const openCase = makeOpenCase();
    const resolvedCase = {
      ...openCase,
      status: "accepted",
      platformReviewStatus: "resolved",
      saleSafetyBlockerState: null,
    };
    const resolved = {
      case: resolvedCase,
      previousCase: openCase,
      inventoryMovement: {
        inventoryId: INVENTORY_ID,
        deltaQty: -2,
        reason: "adjust",
        note: "counted on site",
      },
      clearedBlocker: true,
    };
    const { service, repository, auditService } = makeService({
      resolveCase: vi.fn().mockResolvedValue(resolved),
    });

    const result = await service.resolveCase("admin-1", RAW_CASE_ID, {
      action: "manual_correct",
      note: "counted on site",
      clearBlocker: true,
      correctedOnHandQty: 4,
    });

    expect(repository.resolveCase).toHaveBeenCalledWith(RAW_CASE_ID, {
      action: "manual_correct",
      note: "counted on site",
      clearBlocker: true,
      correctedOnHandQty: 4,
      adminUserId: "admin-1",
    });
    expect(auditService.record).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "stock_reconciliation.manual_correct",
      resourceType: "machine_raw_stock_movement",
      resourceId: RAW_CASE_ID,
      beforeJson: expect.objectContaining({
        platformReviewStatus: "open",
      }),
      afterJson: expect.objectContaining({
        action: "manual_correct",
        clearedBlocker: true,
        inventoryMovement: expect.objectContaining({
          deltaQty: -2,
        }),
      }),
    });
    expect(result).toMatchObject({
      id: RAW_CASE_ID,
      platformReviewStatus: "resolved",
      resolution: {
        action: "manual_correct",
        clearedBlocker: true,
      },
    });
  });

  it("audits conflict reconciliation against the conflict resource for investigation trails", async () => {
    const conflictCase = {
      ...makeOpenCase(),
      id: CONFLICT_CASE_ID,
      caseTable: "machine_raw_stock_movement_conflicts" as const,
      rawMovementId: RAW_CASE_ID,
      reconciliationReason: "movement_id_payload_conflict",
    };
    const { service, auditService } = makeService({
      resolveCase: vi.fn().mockResolvedValue({
        case: {
          ...conflictCase,
          platformReviewStatus: "resolved",
        },
        previousCase: conflictCase,
        inventoryMovement: null,
        clearedBlocker: false,
      }),
    });

    await service.resolveCase("admin-1", CONFLICT_CASE_ID, {
      action: "reject_machine_stock",
      note: "payload conflicts with accepted movement",
      clearBlocker: false,
    });

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "machine_raw_stock_movement_conflict",
        resourceId: CONFLICT_CASE_ID,
      }),
    );
  });

  it("requires corrected quantity for manual correction", async () => {
    const { service } = makeService();

    await expect(
      service.resolveCase("admin-1", RAW_CASE_ID, {
        action: "manual_correct",
        note: "counted on site",
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("returns not found when resolving a missing case", async () => {
    const { service } = makeService({
      resolveCase: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.resolveCase("admin-1", "missing", {
        action: "reject_machine_stock",
        note: "payload not trusted",
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
