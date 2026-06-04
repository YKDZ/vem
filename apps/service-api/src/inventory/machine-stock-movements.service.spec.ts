import type { RawMachineStockMovement } from "@vem/shared";

import { describe, expect, it } from "vitest";

import type { AuthenticatedMachine } from "../machine-auth/current-machine.decorator";
import type {
  InsertRawMachineStockMovement,
  StoredRawMachineStockMovement,
} from "./machine-stock-movements.repository";

import { MachineStockMovementsService } from "./machine-stock-movements.service";

class InMemoryMovementRepository {
  private readonly rows = new Map<string, StoredRawMachineStockMovement>();

  async findByMachineMovement(
    machineId: string,
    movementId: string,
  ): Promise<StoredRawMachineStockMovement | null> {
    return this.rows.get(`${machineId}:${movementId}`) ?? null;
  }

  async insertAccepted(
    input: InsertRawMachineStockMovement,
  ): Promise<StoredRawMachineStockMovement> {
    const row: StoredRawMachineStockMovement = {
      id: `raw-${this.rows.size + 1}`,
      machineId: input.machineId,
      movementId: input.input.movementId,
      payloadHash: input.payloadHash,
      status: "accepted",
      receivedAt: new Date("2026-06-04T00:00:00.000Z"),
    };
    this.rows.set(`${input.machineId}:${input.input.movementId}`, row);
    return row;
  }

  get size(): number {
    return this.rows.size;
  }
}

describe("MachineStockMovementsService", () => {
  const machine: AuthenticatedMachine = {
    id: "550e8400-e29b-41d4-a716-446655440010",
    code: "MACHINE-1",
    status: "online",
  };
  const movement: RawMachineStockMovement = {
    machineCode: "MACHINE-1",
    movementId: "MOVE-1",
    planogramVersion: "PLAN-1",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    movementType: "planned_refill",
    quantity: 3,
    source: "field_service",
    attributedTo: "operator-1",
    occurredAt: "2026-06-04T00:00:00.000Z",
  };

  it("accepts a new raw movement and treats identical duplicate as already accepted", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    const accepted = await service.receiveRawMovement(machine, movement);
    expect(accepted.status).toBe("accepted");
    expect(accepted.receipt?.rawMovementId).toBe("raw-1");

    const duplicate = await service.receiveRawMovement(machine, {
      ...movement,
    });
    expect(duplicate.status).toBe("already_accepted");
    expect(duplicate.receipt?.rawMovementId).toBe("raw-1");
    expect(repo.size).toBe(1);
  });

  it("sends a duplicate movement id with conflicting payload to reconciliation", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    await service.receiveRawMovement(machine, movement);
    const conflict = await service.receiveRawMovement(machine, {
      ...movement,
      quantity: 4,
    });

    expect(conflict.status).toBe("reconciliation");
    expect(conflict.rejection?.reason).toBe("movement_id_payload_conflict");
    expect(repo.size).toBe(1);
  });
});
