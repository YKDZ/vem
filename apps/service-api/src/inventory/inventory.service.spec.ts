import type { RawMachineStockMovement } from "@vem/shared";

import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import { HardwareErrorPoliciesService } from "../hardware-error-policies/hardware-error-policies.service";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "./inventory.service";
import { MachineStockMovementsService } from "./machine-stock-movements.service";

const mockNotificationsService = { createForMachine: vi.fn() };
const mockHardwarePoliciesService = { getPolicy: vi.fn() };

function objectGraphContainsColumnName(
  value: unknown,
  columnName: string,
): boolean {
  const seen = new Set<unknown>();
  const visit = (current: unknown): boolean => {
    if (current === null || typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if ("name" in current && Reflect.get(current, "name") === columnName) {
      return true;
    }
    for (const key of Reflect.ownKeys(current)) {
      if (visit(Reflect.get(current, key))) return true;
    }
    return false;
  };
  return visit(value);
}

function makeMockTx(
  orderItemRows: { inventoryId: string; quantity: number }[],
) {
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

describe("InventoryService.releaseReservation", () => {
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

  it("targets the failed order line reservation when orderItemId is supplied", async () => {
    const whereArgs: unknown[] = [];
    const tx = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: (arg: unknown) => {
            whereArgs.push(arg);
            return {
              limit: async () => [{ id: "reservation-line-2", quantity: 1 }],
            };
          },
        }),
      }),
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      insert: vi
        .fn()
        .mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    };

    await service.releaseReservation(tx as never, {
      orderId: "order1",
      orderItemId: "line-2",
      inventoryId: "inv1",
      quantity: 1,
      reason: "dispense_failed",
    });

    expect(whereArgs).toHaveLength(1);
    expect(objectGraphContainsColumnName(whereArgs[0], "order_item_id")).toBe(
      true,
    );
  });
});

describe("MachineStockMovementsService pending failed line refunds", () => {
  it("dispatches the durable partial refund staged with the final line confirmation", async () => {
    const machine = {
      id: "machine-1",
      code: "M001",
      status: "online",
    };
    const lineBMovement: RawMachineStockMovement = {
      machineCode: "M001",
      movementId: "MOVE-LINE-B",
      planogramVersion: "PLAN-1",
      slotId: "slot-b",
      movementType: "dispense_succeeded",
      quantity: 1,
      source: "vending_command",
      attributedTo: "CMD-B",
      occurredAt: "2026-06-05T12:00:00.000Z",
      orderContext: {
        orderNo: "ORD-1",
        orderItemId: "line-b",
        inventoryId: "inv-b",
        vendingCommandNo: "CMD-B",
      },
    };
    const confirmedDispenses: unknown[] = [];
    const fieldStockApplications: unknown[] = [];
    const repository = {
      findByMachineMovement: vi.fn().mockResolvedValue(null),
      getOrderBoundDispenseConfirmationContext: vi.fn().mockResolvedValue({
        orderId: "order-1",
        orderItemId: "line-b",
        inventoryId: "inv-b",
        quantity: 1,
        vendingCommandId: "cmd-b",
      }),
      insertAcceptedWithOrderBoundDispenseConfirmation: vi
        .fn()
        .mockImplementation(
          async (input: { input: RawMachineStockMovement }) => {
            confirmedDispenses.push(input);
            return {
              id: "raw-line-b",
              machineId: machine.id,
              movementId: input.input.movementId,
              payloadHash: "hash-line-b",
              status: "accepted",
              receivedAt: new Date("2026-06-05T12:00:00.000Z"),
              reconciliationReason: null,
              platformReviewStatus: null,
              saleSafetyBlockerState: null,
              saleSafetyBlockerSlotId: null,
            };
          },
        ),
      insertAccepted: vi.fn(),
      insertReconciliation: vi.fn(),
      applyTrustedFieldStockMovement: vi
        .fn()
        .mockImplementation(async (input: unknown) => {
          fieldStockApplications.push(input);
          return true;
        }),
      buildPendingFailedLinePartialRefundDecision: vi.fn().mockResolvedValue({
        orderId: "order-1",
        orderItemIds: ["line-a"],
        amountCents: 300,
        metadata: {
          rawMovementId: "raw-line-b",
          movementId: "MOVE-LINE-B",
        },
      }),
    };
    const dispatchPendingRefunds = vi.fn().mockResolvedValue(1);
    const service = new MachineStockMovementsService(
      repository as never,
      { dispatchPendingRefunds } as never,
    );

    const result = await service.receiveRawMovement(
      machine as never,
      lineBMovement,
    );

    expect(result.status).toBe("accepted");
    expect(confirmedDispenses).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          orderItemId: "line-b",
          inventoryId: "inv-b",
        }),
      }),
    ]);
    expect(fieldStockApplications).toHaveLength(0);
    expect(
      repository.buildPendingFailedLinePartialRefundDecision,
    ).not.toHaveBeenCalled();
    expect(dispatchPendingRefunds).toHaveBeenCalledOnce();
  });
});
