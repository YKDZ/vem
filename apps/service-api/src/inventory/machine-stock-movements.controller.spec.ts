import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { MachineStockMovementsController } from "./machine-stock-movements.controller";

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
});
