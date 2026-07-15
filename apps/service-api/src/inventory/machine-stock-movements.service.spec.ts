import type { RawMachineStockMovement } from "@vem/shared";

import { describe, expect, it } from "vitest";

import type { AuthenticatedMachine } from "../machine-auth/current-machine.decorator";
import type {
  InsertRawMachineStockMovement,
  ConfirmOrderBoundDispenseInput,
  OrderBoundDispenseConfirmationContext,
  StoredRawMachineStockMovement,
} from "./machine-stock-movements.repository";

import { MachineStockMovementsService } from "./machine-stock-movements.service";

class InMemoryMovementRepository {
  protected readonly rows = new Map<string, StoredRawMachineStockMovement>();
  readonly reconciliationInputs: unknown[] = [];
  readonly conflictInputs: Array<
    InsertRawMachineStockMovement & {
      rawMovementId: string;
      reconciliationReason: string;
      platformReviewStatus: string;
      saleSafetyBlockerState: string | null;
      saleSafetyBlockerSlotId: string | null;
    }
  > = [];
  movementContext = {
    machineSlotKnown: true,
    planogramKnown: true,
    planogramActive: true,
    slotInPlanogram: true,
  };
  activeAcknowledgedPlanogramSlot = {
    slotCode: "A1",
    capacity: 8,
    inventoryId: "550e8400-e29b-41d4-a716-446655440201",
    variantId: "550e8400-e29b-41d4-a716-446655440301",
  } as {
    slotCode: string;
    capacity: number;
    inventoryId: string;
    variantId: string;
  } | null;
  readonly activePlanogramSlotInputs: Array<{
    machineId: string;
    planogramVersion: string;
    slotId: string;
  }> = [];
  orderBoundDispenseContext: OrderBoundDispenseConfirmationContext | null = {
    orderId: "ord-001",
    orderItemId: "550e8400-e29b-41d4-a716-446655440101",
    inventoryId: "550e8400-e29b-41d4-a716-446655440201",
    quantity: 1,
    vendingCommandId: "vcmd-001",
  };
  orderBoundDispenseContextPlanogramVersion: string | null = null;
  readonly confirmationInputs: ConfirmOrderBoundDispenseInput[] = [];
  readonly repairedCommandNos: string[] = [];
  confirmOrderBoundDispenseResult = true;
  readonly fieldStockApplicationInputs: Array<{
    machineId: string;
    rawMovementId: string;
    input: RawMachineStockMovement;
  }> = [];
  applyTrustedFieldStockMovementResult = true;
  readonly localMaintenanceSlotRestoreInputs: Array<{
    machineId: string;
    slotId: string;
  }> = [];

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
      reconciliationReason: null,
      platformReviewStatus: null,
      saleSafetyBlockerState: null,
      saleSafetyBlockerSlotId: null,
    };
    this.rows.set(`${input.machineId}:${input.input.movementId}`, row);
    return row;
  }

  async insertAcceptedWithOrderBoundDispenseConfirmation(
    input: Omit<InsertRawMachineStockMovement, "input"> & {
      input: RawMachineStockMovement & { movementType: "dispense_succeeded" };
      context: OrderBoundDispenseConfirmationContext;
    },
  ): Promise<StoredRawMachineStockMovement | null> {
    const row: StoredRawMachineStockMovement = {
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
    const confirmed = await this.confirmOrderBoundDispenseSucceeded({
      machineId: input.machineId,
      rawMovementId: row.id,
      input: input.input,
      context: input.context,
    });
    if (!confirmed) {
      return null;
    }
    this.rows.set(`${input.machineId}:${input.input.movementId}`, row);
    return row;
  }

  async repairAcceptedOrderBoundDispenseCommand(
    _machineId: string,
    input: RawMachineStockMovement & { movementType: "dispense_succeeded" },
  ): Promise<boolean> {
    const commandNo = input.orderContext?.vendingCommandNo;
    if (!commandNo) return false;
    this.repairedCommandNos.push(commandNo);
    return true;
  }

  async insertReconciliation(
    input: InsertRawMachineStockMovement & {
      reconciliationReason: string;
      platformReviewStatus: string;
      saleSafetyBlockerState: string | null;
      saleSafetyBlockerSlotId: string | null;
    },
  ): Promise<StoredRawMachineStockMovement> {
    this.reconciliationInputs.push(input);
    const row: StoredRawMachineStockMovement = {
      id: `raw-${this.rows.size + 1}`,
      machineId: input.machineId,
      movementId: input.input.movementId,
      payloadHash: input.payloadHash,
      status: "reconciliation",
      receivedAt: new Date("2026-06-04T00:00:00.000Z"),
      reconciliationReason: null,
      platformReviewStatus: null,
      saleSafetyBlockerState: null,
      saleSafetyBlockerSlotId: null,
    };
    this.rows.set(`${input.machineId}:${input.input.movementId}`, row);
    return row;
  }

  async insertConflictReconciliation(
    input: InsertRawMachineStockMovement & {
      rawMovementId: string;
      reconciliationReason: string;
      platformReviewStatus: string;
      saleSafetyBlockerState: string | null;
      saleSafetyBlockerSlotId: string | null;
    },
  ): Promise<StoredRawMachineStockMovement> {
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

  async markReconciliation(
    machineId: string,
    movementId: string,
    input: {
      reconciliationReason: string;
      platformReviewStatus: string;
      saleSafetyBlockerState: string | null;
      saleSafetyBlockerSlotId: string | null;
    },
  ): Promise<void> {
    this.reconciliationInputs.push({ machineId, movementId, ...input });
    const row = this.rows.get(`${machineId}:${movementId}`);
    if (row) {
      this.rows.set(`${machineId}:${movementId}`, {
        ...row,
        status: "reconciliation",
      });
    }
  }

  async getMovementApplicationContext() {
    return this.movementContext;
  }

  async getActiveAcknowledgedPlanogramSlot(
    machineId: string,
    planogramVersion: string,
    slotId: string,
  ) {
    this.activePlanogramSlotInputs.push({
      machineId,
      planogramVersion,
      slotId,
    });
    return this.activeAcknowledgedPlanogramSlot;
  }

  async getOrderBoundDispenseConfirmationContext(
    _machineId: string,
    input: RawMachineStockMovement & { movementType: "dispense_succeeded" },
  ) {
    if (
      this.orderBoundDispenseContextPlanogramVersion &&
      input.planogramVersion !== this.orderBoundDispenseContextPlanogramVersion
    ) {
      return null;
    }
    return this.orderBoundDispenseContext;
  }

  async confirmOrderBoundDispenseSucceeded(
    input: ConfirmOrderBoundDispenseInput,
  ): Promise<boolean> {
    this.confirmationInputs.push(input);
    return this.confirmOrderBoundDispenseResult;
  }

  async applyTrustedFieldStockMovement(input: {
    machineId: string;
    rawMovementId: string;
    input: RawMachineStockMovement;
  }): Promise<boolean> {
    this.fieldStockApplicationInputs.push(input);
    return this.applyTrustedFieldStockMovementResult;
  }

  async restoreSlotAfterAcceptedLocalMaintenance(input: {
    machineId: string;
    slotId: string;
  }): Promise<void> {
    this.localMaintenanceSlotRestoreInputs.push(input);
  }

  async buildPendingFailedLinePartialRefundDecision() {
    return null;
  }

  acceptedOrderBoundDispenseMovement: {
    movementId: string;
    orderId: string;
    vendingCommandId: string;
    quantity: number;
    beforeQuantity: number | null;
    afterQuantity: number | null;
    deltaQuantity: number;
  } | null = {
    movementId: "MOVE-DISPENSE-1",
    orderId: "ord-001",
    vendingCommandId: "vcmd-001",
    quantity: 1,
    beforeQuantity: 3,
    afterQuantity: 2,
    deltaQuantity: -1,
  };

  async findAcceptedOrderBoundDispenseMovement() {
    return this.acceptedOrderBoundDispenseMovement;
  }

  get size(): number {
    return this.rows.size;
  }

  rowFor(
    machineId: string,
    movementId: string,
  ): StoredRawMachineStockMovement | null {
    return this.rows.get(`${machineId}:${movementId}`) ?? null;
  }
}
class InsertRaceMovementRepository extends InMemoryMovementRepository {
  constructor(private readonly existing: StoredRawMachineStockMovement) {
    super();
  }

  override async findByMachineMovement(
    machineId: string,
    movementId: string,
  ): Promise<StoredRawMachineStockMovement | null> {
    const existing = await super.findByMachineMovement(machineId, movementId);
    if (existing) {
      return existing;
    }
    if (
      machineId === this.existing.machineId &&
      movementId === this.existing.movementId
    ) {
      this.rows.set(`${machineId}:${movementId}`, this.existing);
      return null;
    }
    return null;
  }

  override async insertAccepted(): Promise<StoredRawMachineStockMovement> {
    const error = new Error("duplicate key value violates unique constraint");
    Object.assign(error, {
      code: "23505",
      constraint: "machine_raw_stock_movements_machine_movement_unique",
    });
    throw error;
  }
}

describe("MachineStockMovementsService", () => {
  const machine: AuthenticatedMachine = {
    id: "550e8400-e29b-41d4-a716-446655440010",
    code: "MACHINE-1",
    status: "online",
  };

  it("returns only a quantity-conserving accepted movement bound to the requested order and command", async () => {
    const repository = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repository as never);

    await expect(
      service.getAcceptedOrderBoundDispenseMovement(
        machine,
        "ord-001",
        "vcmd-001",
      ),
    ).resolves.toMatchObject({
      movementId: "MOVE-DISPENSE-1",
      deltaQuantity: -1,
      status: "accepted",
    });

    repository.acceptedOrderBoundDispenseMovement = {
      ...repository.acceptedOrderBoundDispenseMovement!,
      deltaQuantity: 0,
    };
    await expect(
      service.getAcceptedOrderBoundDispenseMovement(
        machine,
        "ord-001",
        "vcmd-001",
      ),
    ).resolves.toBeNull();
  });
  const movement: RawMachineStockMovement = {
    machineCode: "MACHINE-1",
    movementId: "MOVE-1",
    planogramVersion: "PLAN-1",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    movementType: "planned_refill",
    quantity: 3,
    beforeQuantity: 2,
    afterQuantity: 5,
    slotMappingSnapshot: {
      slotCode: "A1",
      capacity: 8,
      inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      variantId: "550e8400-e29b-41d4-a716-446655440301",
    },
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

  it("applies trusted planned refill to platform inventory after raw movement is stored", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);
    const trustedRefill: RawMachineStockMovement = {
      ...movement,
      beforeQuantity: 2,
      afterQuantity: 5,
      slotMappingSnapshot: {
        slotCode: "A1",
        capacity: 8,
        inventoryId: "550e8400-e29b-41d4-a716-446655440201",
        variantId: "550e8400-e29b-41d4-a716-446655440301",
      },
    };

    const result = await service.receiveRawMovement(machine, trustedRefill);

    expect(result.status).toBe("accepted");
    expect(repo.activePlanogramSlotInputs).toEqual([
      {
        machineId: machine.id,
        planogramVersion: trustedRefill.planogramVersion,
        slotId: trustedRefill.slotId,
      },
    ]);
    expect(repo.fieldStockApplicationInputs).toEqual([
      {
        machineId: machine.id,
        rawMovementId: result.receipt?.rawMovementId,
        input: trustedRefill,
      },
    ]);
  });

  it.each([
    [
      "slotCode",
      {
        ...movement.slotMappingSnapshot,
        slotCode: "B9",
      },
    ],
    [
      "capacity",
      {
        ...movement.slotMappingSnapshot,
        capacity: 99,
      },
    ],
    [
      "inventoryId",
      {
        ...movement.slotMappingSnapshot,
        inventoryId: "550e8400-e29b-41d4-a716-446655440999",
      },
    ],
    [
      "variantId",
      {
        ...movement.slotMappingSnapshot,
        variantId: "550e8400-e29b-41d4-a716-446655440998",
      },
    ],
  ] as const)(
    "routes trusted refill with mismatched %s snapshot to reconciliation",
    async (_field, spoofedSnapshot) => {
      const repo = new InMemoryMovementRepository();
      const service = new MachineStockMovementsService(repo as never);

      const result = await service.receiveRawMovement(machine, {
        ...movement,
        movementId: `MOVE-MISMATCH-${String(_field).toUpperCase()}`,
        slotMappingSnapshot: spoofedSnapshot as NonNullable<
          RawMachineStockMovement["slotMappingSnapshot"]
        >,
      });

      expect(result.status).toBe("reconciliation");
      expect(result.reconciliation?.reason).toBe("mapping_mismatch");
      expect(repo.activePlanogramSlotInputs).toHaveLength(1);
      expect(repo.fieldStockApplicationInputs).toHaveLength(0);
    },
  );

  it("routes stale planogram field stock movement to reconciliation before inventory apply", async () => {
    const repo = new InMemoryMovementRepository();
    repo.movementContext = {
      machineSlotKnown: true,
      planogramKnown: true,
      planogramActive: false,
      slotInPlanogram: true,
    };
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-STALE-PLANOGRAM",
      planogramVersion: "PLAN-STALE",
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("inactive_planogram_version");
    expect(repo.activePlanogramSlotInputs).toHaveLength(0);
    expect(repo.fieldStockApplicationInputs).toHaveLength(0);
  });

  it("applies approved stock count correction to platform inventory", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);
    const approvedCount: RawMachineStockMovement = {
      ...movement,
      movementId: "MOVE-COUNT-APPROVED",
      movementType: "stock_count_correction",
      quantity: 4,
      beforeQuantity: 6,
      afterQuantity: 4,
      source: "approved_count",
      attributedTo: "supervisor-1",
    };

    const result = await service.receiveRawMovement(machine, approvedCount);

    expect(result.status).toBe("accepted");
    expect(repo.fieldStockApplicationInputs).toEqual([
      {
        machineId: machine.id,
        rawMovementId: result.receipt?.rawMovementId,
        input: approvedCount,
      },
    ]);
    expect(repo.localMaintenanceSlotRestoreInputs).toHaveLength(0);
  });

  it("applies physical stock attestation count correction to platform inventory", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);
    const attestedCount: RawMachineStockMovement = {
      ...movement,
      movementId: "ATT-001:550e8400-e29b-41d4-a716-446655440001",
      movementType: "stock_count_correction",
      quantity: 4,
      beforeQuantity: 6,
      afterQuantity: 4,
      source: "physical_stock_attestation",
      attributedTo: "operator-1",
    };

    const result = await service.receiveRawMovement(machine, attestedCount);

    expect(result.status).toBe("accepted");
    expect(repo.fieldStockApplicationInputs).toEqual([
      {
        machineId: machine.id,
        rawMovementId: result.receipt?.rawMovementId,
        input: attestedCount,
      },
    ]);
    expect(repo.reconciliationInputs).toHaveLength(0);
  });

  it("applies attributed local maintenance refill to platform inventory", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-LOCAL-REFILL",
      movementType: "planned_refill",
      quantity: 3,
      beforeQuantity: 2,
      afterQuantity: 5,
      source: "local_maintenance",
      attributedTo: "front-panel",
    });

    expect(result.status).toBe("accepted");
    expect(repo.fieldStockApplicationInputs).toEqual([
      {
        machineId: machine.id,
        rawMovementId: result.receipt?.rawMovementId,
        input: {
          ...movement,
          movementId: "MOVE-LOCAL-REFILL",
          movementType: "planned_refill",
          quantity: 3,
          beforeQuantity: 2,
          afterQuantity: 5,
          source: "local_maintenance",
          attributedTo: "front-panel",
        },
      },
    ]);
    expect(repo.localMaintenanceSlotRestoreInputs).toEqual([
      {
        machineId: machine.id,
        slotId: movement.slotId,
      },
    ]);
  });

  it("restores faulted platform slot after accepted local maintenance stock count", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);
    const localCount: RawMachineStockMovement = {
      ...movement,
      movementId: "MOVE-LOCAL-COUNT-ACCEPTED",
      movementType: "stock_count_correction",
      quantity: 4,
      beforeQuantity: 6,
      afterQuantity: 4,
      source: "local_maintenance",
      attributedTo: "front-panel",
    };

    const result = await service.receiveRawMovement(machine, localCount);

    expect(result.status).toBe("accepted");
    expect(repo.fieldStockApplicationInputs).toEqual([
      {
        machineId: machine.id,
        rawMovementId: result.receipt?.rawMovementId,
        input: localCount,
      },
    ]);
    expect(repo.localMaintenanceSlotRestoreInputs).toEqual([
      {
        machineId: machine.id,
        slotId: movement.slotId,
      },
    ]);
  });

  it("routes unattributed local maintenance stock count correction to reconciliation", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-LOCAL-COUNT",
      movementType: "stock_count_correction",
      quantity: 4,
      beforeQuantity: 6,
      afterQuantity: 4,
      source: "local_maintenance",
      attributedTo: null,
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("weak_attribution");
    expect(repo.fieldStockApplicationInputs).toHaveLength(0);
    expect(repo.localMaintenanceSlotRestoreInputs).toHaveLength(0);
  });

  it("routes missing attribution to reconciliation without applying platform inventory", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-MISSING-ATTRIBUTION",
      attributedTo: null,
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("weak_attribution");
    expect(repo.fieldStockApplicationInputs).toHaveLength(0);
  });

  it("routes abnormal planned refill variance to reconciliation", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-ABNORMAL-REFILL",
      quantity: 3,
      beforeQuantity: 2,
      afterQuantity: 8,
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("abnormal_variance");
    expect(repo.fieldStockApplicationInputs).toHaveLength(0);
  });

  it("sends a duplicate movement id with conflicting payload to separate reconciliation audit", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    const accepted = await service.receiveRawMovement(machine, movement);
    const conflict = await service.receiveRawMovement(machine, {
      ...movement,
      quantity: 4,
      afterQuantity: 6,
    });

    expect(conflict.status).toBe("reconciliation");
    expect(conflict.receipt?.rawMovementId).toBe("raw-conflict-1");
    expect(conflict.rejection?.reason).toBe("movement_id_payload_conflict");
    expect(conflict.reconciliation?.platformReview.status).toBe("open");
    expect(conflict.reconciliation?.saleSafetyBlocker?.slotSalesState).toBe(
      "movement_rejected",
    );
    expect(repo.rowFor(machine.id, movement.movementId)).toEqual(
      expect.objectContaining({
        id: accepted.receipt?.rawMovementId,
        status: "accepted",
        payloadHash: accepted.receipt?.payloadHash,
      }),
    );
    expect(repo.conflictInputs).toHaveLength(1);
    expect(repo.conflictInputs[0]).toEqual(
      expect.objectContaining({
        rawMovementId: accepted.receipt?.rawMovementId,
        reconciliationReason: "movement_id_payload_conflict",
        saleSafetyBlockerState: "movement_rejected",
        input: expect.objectContaining({ quantity: 4 }),
      }),
    );
    expect(repo.size).toBe(1);
  });

  it("records reconciliation state when the movement references an unknown machine slot", async () => {
    const repo = new InMemoryMovementRepository();
    repo.movementContext = {
      machineSlotKnown: false,
      planogramKnown: true,
      planogramActive: true,
      slotInPlanogram: false,
    };
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-UNKNOWN-SLOT",
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("unknown_slot");
    expect(result.reconciliation?.saleSafetyBlocker).toEqual({
      slotId: movement.slotId,
      slotSalesState: "needs_platform_review",
      reason: "unknown_slot",
    });
  });

  it("records reconciliation state when the movement references an unknown planogram version", async () => {
    const repo = new InMemoryMovementRepository();
    repo.movementContext = {
      machineSlotKnown: true,
      planogramKnown: false,
      planogramActive: false,
      slotInPlanogram: false,
    };
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-UNKNOWN-PLAN",
      planogramVersion: "PLAN-MISSING",
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("unknown_planogram_version");
    expect(result.reconciliation?.platformReview.status).toBe("open");
    expect(result.reconciliation?.saleSafetyBlocker).toEqual({
      slotId: movement.slotId,
      slotSalesState: "blocked_for_planogram_change",
      reason: "unknown_planogram_version",
    });
    expect(repo.reconciliationInputs).toHaveLength(1);
  });

  it("records reconciliation state when the slot is not mapped in the movement planogram", async () => {
    const repo = new InMemoryMovementRepository();
    repo.movementContext = {
      machineSlotKnown: true,
      planogramKnown: true,
      planogramActive: true,
      slotInPlanogram: false,
    };
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-MAPPING-MISMATCH",
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("mapping_mismatch");
    expect(result.reconciliation?.saleSafetyBlocker?.slotSalesState).toBe(
      "blocked_for_planogram_change",
    );
  });

  it("treats a concurrent unique insert race with the same payload as already accepted", async () => {
    const seedRepo = new InMemoryMovementRepository();
    const seedService = new MachineStockMovementsService(seedRepo as never);
    const accepted = await seedService.receiveRawMovement(machine, movement);
    const repo = new InsertRaceMovementRepository({
      id: accepted.receipt?.rawMovementId ?? "raw-1",
      machineId: machine.id,
      movementId: movement.movementId,
      payloadHash: accepted.receipt?.payloadHash ?? "",
      status: "accepted",
      receivedAt: new Date(accepted.acceptedAt ?? "2026-06-04T00:00:00.000Z"),
      reconciliationReason: null,
      platformReviewStatus: null,
      saleSafetyBlockerState: null,
      saleSafetyBlockerSlotId: null,
    });
    const service = new MachineStockMovementsService(repo as never);

    const duplicate = await service.receiveRawMovement(machine, movement);

    expect(duplicate.status).toBe("already_accepted");
    expect(duplicate.receipt?.rawMovementId).toBe("raw-1");
  });

  it("sends a concurrent unique insert race with a different payload to reconciliation", async () => {
    const seedRepo = new InMemoryMovementRepository();
    const seedService = new MachineStockMovementsService(seedRepo as never);
    const accepted = await seedService.receiveRawMovement(machine, movement);
    const repo = new InsertRaceMovementRepository({
      id: accepted.receipt?.rawMovementId ?? "raw-1",
      machineId: machine.id,
      movementId: movement.movementId,
      payloadHash: accepted.receipt?.payloadHash ?? "",
      status: "accepted",
      receivedAt: new Date(accepted.acceptedAt ?? "2026-06-04T00:00:00.000Z"),
      reconciliationReason: null,
      platformReviewStatus: null,
      saleSafetyBlockerState: null,
      saleSafetyBlockerSlotId: null,
    });
    const service = new MachineStockMovementsService(repo as never);

    const conflict = await service.receiveRawMovement(machine, {
      ...movement,
      quantity: 4,
      afterQuantity: 6,
    });

    expect(conflict.status).toBe("reconciliation");
    expect(conflict.rejection?.reason).toBe("movement_id_payload_conflict");
  });

  it("confirms matching order-bound dispense_succeeded movement once accepted", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-DISPENSE-1",
      movementType: "dispense_succeeded",
      quantity: 1,
      source: "vending_command",
      attributedTo: null,
      orderContext: {
        orderNo: "ORD001",
        orderItemId: "550e8400-e29b-41d4-a716-446655440101",
        vendingCommandNo: "VCMD001",
        inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      },
    });

    expect(result.status).toBe("accepted");
    expect(repo.confirmationInputs).toHaveLength(1);
    expect(repo.confirmationInputs[0]).toEqual(
      expect.objectContaining({
        machineId: machine.id,
        rawMovementId: result.receipt?.rawMovementId,
        context: repo.orderBoundDispenseContext,
        input: expect.objectContaining({
          movementType: "dispense_succeeded",
          orderContext: expect.objectContaining({ orderNo: "ORD001" }),
        }),
      }),
    );
  });

  it("rejects an order-bound dispense_succeeded movement when inventory confirmation cannot commit", async () => {
    const repo = new InMemoryMovementRepository();
    repo.confirmOrderBoundDispenseResult = false;
    const service = new MachineStockMovementsService(repo as never);
    const dispenseMovement: RawMachineStockMovement = {
      ...movement,
      movementId: "MOVE-DISPENSE-CONFIRM-FAILED",
      movementType: "dispense_succeeded",
      quantity: 1,
      source: "vending_command",
      attributedTo: null,
      orderContext: {
        orderNo: "ORD001",
        orderItemId: "550e8400-e29b-41d4-a716-446655440101",
        vendingCommandNo: "VCMD001",
        inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      },
    };

    const rejected = await service.receiveRawMovement(
      machine,
      dispenseMovement,
    );
    const retry = await service.receiveRawMovement(machine, dispenseMovement);

    expect(rejected.status).toBe("rejected");
    expect(rejected.acceptedAt).toBeNull();
    expect(rejected.rejection?.reason).toBe("order_confirmation_failed");
    expect(repo.rowFor(machine.id, dispenseMovement.movementId)).toBeNull();
    expect(retry.status).toBe("rejected");
    expect(repo.confirmationInputs).toHaveLength(2);
  });

  it("does not confirm a duplicate dispense_succeeded movement twice", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);
    const dispenseMovement: RawMachineStockMovement = {
      ...movement,
      movementId: "MOVE-DISPENSE-DUP",
      movementType: "dispense_succeeded",
      quantity: 1,
      source: "vending_command",
      attributedTo: null,
      orderContext: {
        orderNo: "ORD001",
        orderItemId: "550e8400-e29b-41d4-a716-446655440101",
        vendingCommandNo: "VCMD001",
        inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      },
    };

    await service.receiveRawMovement(machine, dispenseMovement);
    const duplicate = await service.receiveRawMovement(
      machine,
      dispenseMovement,
    );

    expect(duplicate.status).toBe("already_accepted");
    expect(repo.confirmationInputs).toHaveLength(1);
  });

  it("matches order-bound dispense_succeeded against the order planogram snapshot instead of the current active planogram", async () => {
    const repo = new InMemoryMovementRepository();
    repo.movementContext = {
      machineSlotKnown: true,
      planogramKnown: true,
      planogramActive: false,
      slotInPlanogram: true,
    };
    repo.orderBoundDispenseContextPlanogramVersion = "PLAN-1";
    const service = new MachineStockMovementsService(repo as never);
    const baseDispenseMovement: RawMachineStockMovement = {
      ...movement,
      movementType: "dispense_succeeded",
      quantity: 1,
      source: "vending_command",
      attributedTo: null,
      orderContext: {
        orderNo: "ORD001",
        orderItemId: "550e8400-e29b-41d4-a716-446655440101",
        vendingCommandNo: "VCMD001",
        inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      },
    };

    const v2Movement = await service.receiveRawMovement(machine, {
      ...baseDispenseMovement,
      movementId: "MOVE-DISPENSE-PLAN-V2",
      planogramVersion: "PLAN-2",
    });
    const v1Movement = await service.receiveRawMovement(machine, {
      ...baseDispenseMovement,
      movementId: "MOVE-DISPENSE-PLAN-V1",
      planogramVersion: "PLAN-1",
    });

    expect(v2Movement.status).toBe("reconciliation");
    expect(v2Movement.reconciliation?.reason).toBe("order_context_mismatch");
    expect(v1Movement.status).toBe("accepted");
    expect(repo.confirmationInputs).toHaveLength(1);
    expect(repo.confirmationInputs[0]?.input.planogramVersion).toBe("PLAN-1");
  });

  it("sends dispense_succeeded with mismatched order context to reconciliation", async () => {
    const repo = new InMemoryMovementRepository();
    repo.orderBoundDispenseContext = null;
    const service = new MachineStockMovementsService(repo as never);

    const result = await service.receiveRawMovement(machine, {
      ...movement,
      movementId: "MOVE-DISPENSE-MISMATCH",
      movementType: "dispense_succeeded",
      quantity: 1,
      source: "vending_command",
      attributedTo: null,
      orderContext: {
        orderNo: "ORD404",
        orderItemId: "550e8400-e29b-41d4-a716-446655440101",
        vendingCommandNo: "VCMD404",
        inventoryId: "550e8400-e29b-41d4-a716-446655440201",
      },
    });

    expect(result.status).toBe("reconciliation");
    expect(result.reconciliation?.reason).toBe("order_context_mismatch");
    expect(repo.confirmationInputs).toHaveLength(0);
  });

  it("persists and hashes the authenticated machine code when body omits machineCode", async () => {
    const repo = new InMemoryMovementRepository();
    const service = new MachineStockMovementsService(repo as never);
    const { machineCode: _machineCode, ...movementWithoutMachineCode } =
      movement;

    await service.receiveRawMovement(machine, movementWithoutMachineCode);
    const duplicateWithBodyMachineCode = await service.receiveRawMovement(
      machine,
      movement,
    );

    expect(duplicateWithBodyMachineCode.status).toBe("already_accepted");
  });
});
