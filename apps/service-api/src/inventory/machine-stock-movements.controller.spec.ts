import type { RawMachineStockMovement } from "@vem/shared";

import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { MachineStockMovementsController } from "./machine-stock-movements.controller";
import { MachineStockMovementsService } from "./machine-stock-movements.service";

class ControllerMovementRepository {
  private readonly rows = new Map<
    string,
    {
      id: string;
      machineId: string;
      movementId: string;
      payloadHash: string;
      status: string;
      receivedAt: Date;
      reconciliationReason: string | null;
      platformReviewStatus: string | null;
      saleSafetyBlockerState: string | null;
      saleSafetyBlockerSlotId: string | null;
    }
  >();
  readonly conflictInputs: unknown[] = [];
  readonly applicationInputs: unknown[] = [];
  readonly markReconciliationInputs: unknown[] = [];

  async findByMachineMovement(machineId: string, movementId: string) {
    return this.rows.get(`${machineId}:${movementId}`) ?? null;
  }

  async insertAccepted(input: {
    machineId: string;
    input: RawMachineStockMovement;
    payloadHash: string;
  }) {
    const row = {
      id: `raw-${this.rows.size + 1}`,
      machineId: input.machineId,
      movementId: input.input.movementId,
      payloadHash: input.payloadHash,
      status: "accepted",
      receivedAt: new Date("2026-06-04T00:00:00.000Z"),
      reconciliationReason: null,
      platformReviewStatus: null,
      saleSafetyBlockerState: null,
      saleSafetyBlockerSlotId: null,
    };
    this.rows.set(`${input.machineId}:${input.input.movementId}`, row);
    return row;
  }

  async insertConflictReconciliation(input: {
    machineId: string;
    input: RawMachineStockMovement;
    payloadHash: string;
    rawMovementId: string;
    reconciliationReason: string;
    platformReviewStatus: string;
    saleSafetyBlockerState: string | null;
    saleSafetyBlockerSlotId: string | null;
  }) {
    this.conflictInputs.push(input);
    return {
      id: `raw-conflict-${this.conflictInputs.length}`,
      machineId: input.machineId,
      movementId: input.input.movementId,
      payloadHash: input.payloadHash,
      status: "reconciliation",
      receivedAt: new Date("2026-06-04T00:00:01.000Z"),
      reconciliationReason: input.reconciliationReason,
      platformReviewStatus: input.platformReviewStatus,
      saleSafetyBlockerState: input.saleSafetyBlockerState,
      saleSafetyBlockerSlotId: input.saleSafetyBlockerSlotId,
    };
  }

  async insertReconciliation(input: {
    machineId: string;
    input: RawMachineStockMovement;
    payloadHash: string;
    reconciliationReason: string;
    platformReviewStatus: string;
    saleSafetyBlockerState: string | null;
    saleSafetyBlockerSlotId: string | null;
  }) {
    const row = {
      id: `raw-${this.rows.size + 1}`,
      machineId: input.machineId,
      movementId: input.input.movementId,
      payloadHash: input.payloadHash,
      status: "reconciliation",
      receivedAt: new Date("2026-06-04T00:00:00.000Z"),
      reconciliationReason: input.reconciliationReason,
      platformReviewStatus: input.platformReviewStatus,
      saleSafetyBlockerState: input.saleSafetyBlockerState,
      saleSafetyBlockerSlotId: input.saleSafetyBlockerSlotId,
    };
    this.rows.set(`${input.machineId}:${input.input.movementId}`, row);
    return row;
  }

  async markReconciliation(...input: unknown[]) {
    this.markReconciliationInputs.push(input);
  }

  async getMovementApplicationContext() {
    return {
      machineSlotKnown: true,
      planogramKnown: true,
      planogramActive: true,
      slotInPlanogram: true,
    };
  }

  async getActiveAcknowledgedPlanogramSlot() {
    return {
      capacity: 8,
      inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      variantId: "550e8400-e29b-41d4-a716-446655440301",
    };
  }

  async getOrderBoundDispenseConfirmationContext() {
    return null;
  }

  async applyTrustedFieldStockMovement(input: unknown) {
    this.applicationInputs.push(input);
    return true;
  }

  async restoreSlotAfterAcceptedLocalMaintenance() {
    return undefined;
  }

  acceptedRow(machineId: string, movementId: string) {
    return this.rows.get(`${machineId}:${movementId}`) ?? null;
  }
}

describe("MachineStockMovementsController", () => {
  const machine = {
    id: "550e8400-e29b-41d4-a716-446655440010",
    code: "MACHINE-1",
    status: "online",
  };
  const movement = {
    machineCode: "MACHINE-1",
    movementId: "MOVE-1",
    planogramVersion: "PLAN-1",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    movementType: "planned_refill",
    quantity: 3,
    beforeQuantity: 2,
    afterQuantity: 5,
    slotMappingSnapshot: {
      capacity: 8,
      inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      variantId: "550e8400-e29b-41d4-a716-446655440301",
    },
    source: "local_maintenance",
    attributedTo: "operator-1",
    occurredAt: "2026-06-04T00:00:00.000Z",
  } as const;

  it("rejects body machineCode that does not match the authenticated machine", async () => {
    const service = {
      receiveRawMovement: vi.fn(),
    };
    const controller = new MachineStockMovementsController(service as never);

    await expect(
      controller.receiveRawMovement(machine as never, {
        ...movement,
        machineCode: "MACHINE-2",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(service.receiveRawMovement).not.toHaveBeenCalled();
  });

  it("uses the authenticated machine code when body machineCode is omitted", async () => {
    const service = {
      receiveRawMovement: vi.fn().mockResolvedValue({ status: "accepted" }),
    };
    const controller = new MachineStockMovementsController(service as never);
    const { machineCode: _machineCode, ...body } = movement;

    await controller.receiveRawMovement(machine as never, body);

    expect(service.receiveRawMovement).toHaveBeenCalledWith(
      machine,
      expect.objectContaining({ machineCode: "MACHINE-1" }),
    );
  });

  it("returns only the accepted order-bound dispense movement for the authenticated machine", async () => {
    const service = {
      getAcceptedOrderBoundDispenseMovement: vi.fn().mockResolvedValue({
        movementId: "MOVE-DISPENSE-1",
        orderId: "order-1",
        vendingCommandId: "command-1",
        quantity: 1,
        beforeQuantity: 3,
        afterQuantity: 2,
        deltaQuantity: -1,
        status: "accepted",
      }),
    };
    const controller = new MachineStockMovementsController(service as never);

    await expect(
      controller.getDispenseConfirmation(
        machine as never,
        "order-1",
        "command-1",
      ),
    ).resolves.toMatchObject({
      movementId: "MOVE-DISPENSE-1",
      deltaQuantity: -1,
    });
    expect(service.getAcceptedOrderBoundDispenseMovement).toHaveBeenCalledWith(
      machine,
      "order-1",
      "command-1",
    );
  });

  it("returns reconciliation shape and keeps the conflicting raw payload separate", async () => {
    const repo = new ControllerMovementRepository();
    const service = new MachineStockMovementsService(repo as never);
    const controller = new MachineStockMovementsController(service);

    const accepted = await controller.receiveRawMovement(
      machine as never,
      movement,
    );
    const conflict = await controller.receiveRawMovement(machine as never, {
      ...movement,
      quantity: 4,
      afterQuantity: 6,
    });

    expect(conflict).toMatchObject({
      movementId: "MOVE-1",
      status: "reconciliation",
      acceptedAt: null,
      receipt: { rawMovementId: "raw-conflict-1" },
      rejection: { reason: "movement_id_payload_conflict" },
      reconciliation: {
        reason: "movement_id_payload_conflict",
        platformReview: { required: true, status: "open" },
        saleSafetyBlocker: {
          slotId: movement.slotId,
          slotSalesState: "movement_rejected",
          reason: "movement_id_payload_conflict",
        },
      },
    });
    expect(repo.acceptedRow(machine.id, movement.movementId)).toMatchObject({
      id: accepted.receipt?.rawMovementId,
      status: "accepted",
      payloadHash: accepted.receipt?.payloadHash,
    });
    expect(repo.conflictInputs).toEqual([
      expect.objectContaining({
        rawMovementId: accepted.receipt?.rawMovementId,
        reconciliationReason: "movement_id_payload_conflict",
        input: expect.objectContaining({ quantity: 4 }),
      }),
    ]);
  });
});
