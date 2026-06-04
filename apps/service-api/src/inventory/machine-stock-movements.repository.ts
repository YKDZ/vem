import type { RawMachineStockMovement } from "@vem/shared";

import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  eq,
  isNull,
  machinePlanogramSlots,
  machinePlanogramVersions,
  machineRawStockMovementConflicts,
  machineRawStockMovements,
  machineSlots,
  type DrizzleClient,
} from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";

export type StoredRawMachineStockMovement = {
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
};

export type InsertRawMachineStockMovement = {
  machineId: string;
  input: RawMachineStockMovement;
  normalized: Record<string, unknown>;
  payloadHash: string;
};

export type InsertReconciliationRawMachineStockMovement =
  InsertRawMachineStockMovement & {
    reconciliationReason: string;
    platformReviewStatus: string;
    saleSafetyBlockerState: string | null;
    saleSafetyBlockerSlotId: string | null;
  };

export type InsertConflictRawMachineStockMovement =
  InsertReconciliationRawMachineStockMovement & {
    rawMovementId: string;
  };

export type MovementApplicationContext = {
  machineSlotKnown: boolean;
  planogramKnown: boolean;
  planogramActive: boolean;
  slotInPlanogram: boolean;
};

@Injectable()
export class MachineStockMovementsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async findByMachineMovement(
    machineId: string,
    movementId: string,
  ): Promise<StoredRawMachineStockMovement | null> {
    const [row] = await this.db
      .select({
        id: machineRawStockMovements.id,
        machineId: machineRawStockMovements.machineId,
        movementId: machineRawStockMovements.movementId,
        payloadHash: machineRawStockMovements.payloadHash,
        status: machineRawStockMovements.status,
        receivedAt: machineRawStockMovements.receivedAt,
        reconciliationReason: machineRawStockMovements.reconciliationReason,
        platformReviewStatus: machineRawStockMovements.platformReviewStatus,
        saleSafetyBlockerState: machineRawStockMovements.saleSafetyBlockerState,
        saleSafetyBlockerSlotId:
          machineRawStockMovements.saleSafetyBlockerSlotId,
      })
      .from(machineRawStockMovements)
      .where(
        and(
          eq(machineRawStockMovements.machineId, machineId),
          eq(machineRawStockMovements.movementId, movementId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async insertAccepted(
    input: InsertRawMachineStockMovement,
  ): Promise<StoredRawMachineStockMovement> {
    return await this.insertRaw(input, {
      status: "accepted",
      reconciliationReason: null,
      platformReviewStatus: null,
      saleSafetyBlockerState: null,
      saleSafetyBlockerSlotId: null,
    });
  }

  async insertReconciliation(
    input: InsertReconciliationRawMachineStockMovement,
  ): Promise<StoredRawMachineStockMovement> {
    return await this.insertRaw(input, {
      status: "reconciliation",
      reconciliationReason: input.reconciliationReason,
      platformReviewStatus: input.platformReviewStatus,
      saleSafetyBlockerState: input.saleSafetyBlockerState,
      saleSafetyBlockerSlotId: input.saleSafetyBlockerSlotId,
    });
  }

  async insertConflictReconciliation(
    input: InsertConflictRawMachineStockMovement,
  ): Promise<StoredRawMachineStockMovement> {
    const [row] = await this.db
      .insert(machineRawStockMovementConflicts)
      .values({
        rawMovementId: input.rawMovementId,
        machineId: input.machineId,
        movementId: input.input.movementId,
        payloadHash: input.payloadHash,
        payloadJson: input.input,
        normalizedJson: input.normalized,
        status: "reconciliation",
        reconciliationReason: input.reconciliationReason,
        platformReviewStatus: input.platformReviewStatus,
        saleSafetyBlockerState: input.saleSafetyBlockerState,
        saleSafetyBlockerSlotId: input.saleSafetyBlockerSlotId,
      })
      .returning({
        id: machineRawStockMovementConflicts.id,
        machineId: machineRawStockMovementConflicts.machineId,
        movementId: machineRawStockMovementConflicts.movementId,
        payloadHash: machineRawStockMovementConflicts.payloadHash,
        status: machineRawStockMovementConflicts.status,
        receivedAt: machineRawStockMovementConflicts.receivedAt,
        reconciliationReason:
          machineRawStockMovementConflicts.reconciliationReason,
        platformReviewStatus:
          machineRawStockMovementConflicts.platformReviewStatus,
        saleSafetyBlockerState:
          machineRawStockMovementConflicts.saleSafetyBlockerState,
        saleSafetyBlockerSlotId:
          machineRawStockMovementConflicts.saleSafetyBlockerSlotId,
      });
    return row;
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
    await this.db
      .update(machineRawStockMovements)
      .set({
        status: "reconciliation",
        reconciliationReason: input.reconciliationReason,
        platformReviewStatus: input.platformReviewStatus,
        saleSafetyBlockerState: input.saleSafetyBlockerState,
        saleSafetyBlockerSlotId: input.saleSafetyBlockerSlotId,
      })
      .where(
        and(
          eq(machineRawStockMovements.machineId, machineId),
          eq(machineRawStockMovements.movementId, movementId),
        ),
      );
  }

  async getMovementApplicationContext(
    machineId: string,
    planogramVersion: string,
    slotId: string,
  ): Promise<MovementApplicationContext> {
    const [slot] = await this.db
      .select({ id: machineSlots.id })
      .from(machineSlots)
      .where(
        and(
          eq(machineSlots.machineId, machineId),
          eq(machineSlots.id, slotId),
          isNull(machineSlots.deletedAt),
        ),
      )
      .limit(1);

    const [version] = await this.db
      .select({
        id: machinePlanogramVersions.id,
        status: machinePlanogramVersions.status,
      })
      .from(machinePlanogramVersions)
      .where(
        and(
          eq(machinePlanogramVersions.machineId, machineId),
          eq(machinePlanogramVersions.planogramVersion, planogramVersion),
        ),
      )
      .limit(1);

    const [versionSlot] = version
      ? await this.db
          .select({ id: machinePlanogramSlots.id })
          .from(machinePlanogramSlots)
          .where(
            and(
              eq(machinePlanogramSlots.machinePlanogramVersionId, version.id),
              eq(machinePlanogramSlots.slotId, slotId),
            ),
          )
          .limit(1)
      : [];

    return {
      machineSlotKnown: Boolean(slot),
      planogramKnown: Boolean(version),
      planogramActive: version?.status === "active",
      slotInPlanogram: Boolean(versionSlot),
    };
  }

  private async insertRaw(
    input: InsertRawMachineStockMovement,
    status: {
      status: "accepted" | "reconciliation";
      reconciliationReason: string | null;
      platformReviewStatus: string | null;
      saleSafetyBlockerState: string | null;
      saleSafetyBlockerSlotId: string | null;
    },
  ): Promise<StoredRawMachineStockMovement> {
    const [row] = await this.db
      .insert(machineRawStockMovements)
      .values({
        machineId: input.machineId,
        movementId: input.input.movementId,
        planogramVersion: input.input.planogramVersion,
        slotId: input.input.slotId,
        movementType: input.input.movementType,
        quantity: input.input.quantity,
        source: input.input.source,
        attributedTo: input.input.attributedTo ?? null,
        occurredAt: new Date(input.input.occurredAt),
        payloadHash: input.payloadHash,
        payloadJson: input.input,
        normalizedJson: input.normalized,
        status: status.status,
        reconciliationReason: status.reconciliationReason,
        platformReviewStatus: status.platformReviewStatus,
        saleSafetyBlockerState: status.saleSafetyBlockerState,
        saleSafetyBlockerSlotId: status.saleSafetyBlockerSlotId,
      })
      .returning({
        id: machineRawStockMovements.id,
        machineId: machineRawStockMovements.machineId,
        movementId: machineRawStockMovements.movementId,
        payloadHash: machineRawStockMovements.payloadHash,
        status: machineRawStockMovements.status,
        receivedAt: machineRawStockMovements.receivedAt,
        reconciliationReason: machineRawStockMovements.reconciliationReason,
        platformReviewStatus: machineRawStockMovements.platformReviewStatus,
        saleSafetyBlockerState: machineRawStockMovements.saleSafetyBlockerState,
        saleSafetyBlockerSlotId:
          machineRawStockMovements.saleSafetyBlockerSlotId,
      });
    return row;
  }
}
