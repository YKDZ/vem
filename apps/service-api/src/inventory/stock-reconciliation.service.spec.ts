import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuditService } from "../audit/audit.service";

import {
  StockReconciliationService,
  type StockReconciliationRepository,
} from "./stock-reconciliation.service";

function makeOpenCase() {
  return {
    id: "raw-1",
    caseTable: "machine_raw_stock_movements" as const,
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
    attributedTo: "front-panel",
    occurredAt: new Date("2026-06-04T04:00:00.000Z"),
    receivedAt: new Date("2026-06-04T04:01:00.000Z"),
    status: "reconciliation",
    reconciliationReason: "weak_attribution",
    platformReviewStatus: "open",
    saleSafetyBlockerState: "needs_platform_review",
    saleSafetyBlockerSlotId: "slot-1",
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
    inventoryId: "inventory-1",
    productName: "测试商品",
    sku: "SKU-1",
    onHandQty: 6,
    reservedQty: 1,
    slotStatus: "enabled",
    linkedOrderId: "order-1",
    linkedOrderNo: "ORD-1",
    linkedCommandId: "command-1",
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
          id: "raw-1",
          machineCode: "M001",
          movementId: "MOVE-1",
          slot: {
            id: "slot-1",
            code: "A1",
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
            linkedCaseId: "raw-1",
            linkedOrderNo: "ORD-1",
            linkedCommandNo: "VCMD-1",
          },
        },
      ],
    });
  });

  it("opens detail evidence for one stock reconciliation case", async () => {
    const { service } = makeService();

    const detail = await service.getCase("raw-1");

    expect(detail).toMatchObject({
      id: "raw-1",
      evidence: {
        rawPayload: {
          movementId: "MOVE-1",
          beforeQuantity: 6,
          afterQuantity: 4,
        },
        normalizedPayload: { movementId: "MOVE-1" },
        inventory: {
          id: "inventory-1",
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
      service.resolveCase("admin-1", "raw-1", {
        action: "accept_machine_stock",
        note: " ",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("writes inventory movement and admin audit for accepted machine stock", async () => {
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
        inventoryId: "inventory-1",
        deltaQty: -2,
        reason: "hardware_sync",
        note: "accept stock count",
      },
      clearedBlocker: true,
    };
    const { service, repository, auditService } = makeService({
      resolveCase: vi.fn().mockResolvedValue(resolved),
    });

    const result = await service.resolveCase("admin-1", "raw-1", {
      action: "accept_machine_stock",
      note: "accept stock count",
      clearBlocker: true,
    });

    expect(repository.resolveCase).toHaveBeenCalledWith("raw-1", {
      action: "accept_machine_stock",
      note: "accept stock count",
      clearBlocker: true,
      correctedOnHandQty: undefined,
      adminUserId: "admin-1",
    });
    expect(auditService.record).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "stock_reconciliation.accept_machine_stock",
      resourceType: "machine_raw_stock_movement",
      resourceId: "raw-1",
      beforeJson: expect.objectContaining({
        platformReviewStatus: "open",
      }),
      afterJson: expect.objectContaining({
        action: "accept_machine_stock",
        clearedBlocker: true,
        inventoryMovement: expect.objectContaining({
          deltaQty: -2,
        }),
      }),
    });
    expect(result).toMatchObject({
      id: "raw-1",
      platformReviewStatus: "resolved",
      resolution: {
        action: "accept_machine_stock",
        clearedBlocker: true,
      },
    });
  });

  it("audits conflict reconciliation against the conflict resource for investigation trails", async () => {
    const conflictCase = {
      ...makeOpenCase(),
      id: "conflict-1",
      caseTable: "machine_raw_stock_movement_conflicts" as const,
      rawMovementId: "raw-1",
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

    await service.resolveCase("admin-1", "conflict-1", {
      action: "reject_machine_stock",
      note: "payload conflicts with accepted movement",
      clearBlocker: false,
    });

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "machine_raw_stock_movement_conflict",
        resourceId: "conflict-1",
      }),
    );
  });

  it("requires corrected quantity for manual correction", async () => {
    const { service } = makeService();

    await expect(
      service.resolveCase("admin-1", "raw-1", {
        action: "manual_correct",
        note: "counted on site",
      }),
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
