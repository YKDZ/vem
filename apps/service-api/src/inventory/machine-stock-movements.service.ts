import type { RawMachineStockMovement } from "@vem/shared";

import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

import type { AuthenticatedMachine } from "../machine-auth/current-machine.decorator";

import {
  MachineStockMovementsRepository,
  type StoredRawMachineStockMovement,
} from "./machine-stock-movements.repository";

export type MachineStockMovementIngestionResponse = {
  movementId: string;
  status: "accepted" | "already_accepted" | "rejected" | "reconciliation";
  acceptedAt: string | null;
  receipt?: {
    rawMovementId: string;
    payloadHash: string;
  };
  rejection?: {
    reason: string;
    existingPayloadHash?: string;
    receivedPayloadHash: string;
  };
};

@Injectable()
export class MachineStockMovementsService {
  constructor(private readonly repository: MachineStockMovementsRepository) {}

  async receiveRawMovement(
    machine: AuthenticatedMachine,
    input: RawMachineStockMovement,
  ): Promise<MachineStockMovementIngestionResponse> {
    const normalized = normalizeRawMovement(input);
    const payloadHash = hashNormalizedMovement(normalized);
    const existing = await this.repository.findByMachineMovement(
      machine.id,
      input.movementId,
    );

    if (existing) {
      if (existing.payloadHash === payloadHash) {
        return acceptedResponse(input.movementId, existing, "already_accepted");
      }
      return {
        movementId: input.movementId,
        status: "reconciliation",
        acceptedAt: null,
        rejection: {
          reason: "movement_id_payload_conflict",
          existingPayloadHash: existing.payloadHash,
          receivedPayloadHash: payloadHash,
        },
      };
    }

    const stored = await this.repository.insertAccepted({
      machineId: machine.id,
      input,
      normalized,
      payloadHash,
    });
    return acceptedResponse(input.movementId, stored, "accepted");
  }
}

function acceptedResponse(
  movementId: string,
  row: StoredRawMachineStockMovement,
  status: "accepted" | "already_accepted",
): MachineStockMovementIngestionResponse {
  return {
    movementId,
    status,
    acceptedAt: row.receivedAt.toISOString(),
    receipt: {
      rawMovementId: row.id,
      payloadHash: row.payloadHash,
    },
  };
}

export function normalizeRawMovement(
  input: RawMachineStockMovement,
): Record<string, unknown> {
  return {
    movementId: input.movementId,
    planogramVersion: input.planogramVersion,
    slotId: input.slotId,
    movementType: input.movementType,
    quantity: input.quantity,
    source: input.source,
    attributedTo: input.attributedTo ?? null,
    occurredAt: new Date(input.occurredAt).toISOString(),
  };
}

function hashNormalizedMovement(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
