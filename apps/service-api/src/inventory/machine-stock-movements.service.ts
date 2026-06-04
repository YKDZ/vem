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
    const trustedInput: RawMachineStockMovement = {
      ...input,
      machineCode: machine.code,
    };
    const normalized = normalizeRawMovement(trustedInput);
    const payloadHash = hashNormalizedMovement(normalized);
    const existing = await this.repository.findByMachineMovement(
      machine.id,
      trustedInput.movementId,
    );

    if (existing) {
      return responseForExisting(
        trustedInput.movementId,
        existing,
        payloadHash,
      );
    }

    try {
      const stored = await this.repository.insertAccepted({
        machineId: machine.id,
        input: trustedInput,
        normalized,
        payloadHash,
      });
      return acceptedResponse(trustedInput.movementId, stored, "accepted");
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      const concurrent = await this.repository.findByMachineMovement(
        machine.id,
        trustedInput.movementId,
      );
      if (!concurrent) {
        throw error;
      }
      return responseForExisting(
        trustedInput.movementId,
        concurrent,
        payloadHash,
      );
    }
  }
}

function responseForExisting(
  movementId: string,
  existing: StoredRawMachineStockMovement,
  payloadHash: string,
): MachineStockMovementIngestionResponse {
  if (existing.payloadHash === payloadHash) {
    return acceptedResponse(movementId, existing, "already_accepted");
  }
  return {
    movementId,
    status: "reconciliation",
    acceptedAt: null,
    rejection: {
      reason: "movement_id_payload_conflict",
      existingPayloadHash: existing.payloadHash,
      receivedPayloadHash: payloadHash,
    },
  };
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
    machineCode: input.machineCode ?? null,
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

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as { code?: unknown; constraint?: unknown };
  return (
    maybeError.code === "23505" &&
    (maybeError.constraint === undefined ||
      maybeError.constraint ===
        "machine_raw_stock_movements_machine_movement_unique")
  );
}
