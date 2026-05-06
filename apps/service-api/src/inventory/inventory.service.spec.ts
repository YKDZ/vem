import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import { HardwareErrorPoliciesService } from "../hardware-error-policies/hardware-error-policies.service";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "./inventory.service";

const mockNotificationsService = { createForMachine: vi.fn() };
const mockHardwarePoliciesService = { getPolicy: vi.fn() };

function makeMockTx(orderItemRows: { inventoryId: string; quantity: number }[]) {
  const executeResult = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([]),
  });
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([{ id: "slot1" }]),
  });

  return {
    select: vi.fn().mockReturnValue({
      from: () => ({
        where: async () => orderItemRows,
      }),
    }),
    execute: executeResult,
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    _updateSet: updateSet,
  };
}

describe("InventoryService.compensateDispenseFailure", () => {
  let service: InventoryService;
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: NotificationsService, useValue: mockNotificationsService },
        {
          provide: HardwareErrorPoliciesService,
          useValue: mockHardwarePoliciesService,
        },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  it("restores inventory when policy.restoreInventory=true and faultSlot=false (NO_DROP)", async () => {
    mockHardwarePoliciesService.getPolicy.mockResolvedValue({
      errorCode: "NO_DROP",
      restoreInventory: true,
      faultSlot: false,
      requestRefund: true,
      createWorkOrder: false,
      severity: "warning",
    });

    const tx = makeMockTx([{ inventoryId: "inv1", quantity: 1 }]);

    const result = await service.compensateDispenseFailure(tx as never, {
      orderId: "order1",
      slotId: "slot1",
      errorCode: "NO_DROP",
      message: "no drop detected",
    });

    expect(result.restoredQuantity).toBe(1);
    expect(result.slotFaulted).toBe(false);
    expect(tx.execute).toHaveBeenCalled();
  });

  it("faults slot when policy.faultSlot=true (JAMMED) without restoring inventory", async () => {
    mockHardwarePoliciesService.getPolicy.mockResolvedValue({
      errorCode: "JAMMED",
      restoreInventory: false,
      faultSlot: true,
      requestRefund: false,
      createWorkOrder: true,
      severity: "critical",
    });

    const tx = makeMockTx([{ inventoryId: "inv1", quantity: 1 }]);

    const result = await service.compensateDispenseFailure(tx as never, {
      orderId: "order1",
      slotId: "slot1",
      errorCode: "JAMMED",
      message: "jam detected",
    });

    expect(result.restoredQuantity).toBe(0);
    expect(result.slotFaulted).toBe(true);
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.update).toHaveBeenCalled();
  });

  it("handles null errorCode via NULL_ERROR policy", async () => {
    mockHardwarePoliciesService.getPolicy.mockResolvedValue({
      errorCode: null,
      restoreInventory: false,
      faultSlot: true,
      requestRefund: false,
      createWorkOrder: true,
      severity: "critical",
    });

    const tx = makeMockTx([]);

    const result = await service.compensateDispenseFailure(tx as never, {
      orderId: "order1",
      slotId: "slot1",
      errorCode: null,
      message: "unknown error",
    });

    expect(result.slotFaulted).toBe(true);
    expect(mockHardwarePoliciesService.getPolicy).toHaveBeenCalledWith(null);
  });
});
