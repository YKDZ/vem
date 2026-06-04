import type { RawMachineStockMovement } from "@vem/shared";

import { Inject, Injectable } from "@nestjs/common";
import { and, eq, machineRawStockMovements, type DrizzleClient } from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";

export type StoredRawMachineStockMovement = {
  id: string;
  machineId: string;
  movementId: string;
  payloadHash: string;
  status: string;
  receivedAt: Date;
};

export type InsertRawMachineStockMovement = {
  machineId: string;
  input: RawMachineStockMovement;
  normalized: Record<string, unknown>;
  payloadHash: string;
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
        status: "accepted",
      })
      .returning({
        id: machineRawStockMovements.id,
        machineId: machineRawStockMovements.machineId,
        movementId: machineRawStockMovements.movementId,
        payloadHash: machineRawStockMovements.payloadHash,
        status: machineRawStockMovements.status,
        receivedAt: machineRawStockMovements.receivedAt,
      });
    return row;
  }
}
