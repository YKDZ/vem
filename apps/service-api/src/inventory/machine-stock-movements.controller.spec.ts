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

  async getMovementApplicationContext() {
    return {
      machineSlotKnown: true,
      planogramKnown: true,
      planogramActive: true,
      slotInPlanogram: true,
    };
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
    source: "field_service",
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
