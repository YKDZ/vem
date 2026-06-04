import type { RawMachineStockMovement } from "@vem/shared";

import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

import type { AuthenticatedMachine } from "../machine-auth/current-machine.decorator";

import {
  MachineStockMovementsRepository,
  type InsertReconciliationRawMachineStockMovement,
  type OrderBoundDispenseConfirmationContext,
  type StoredRawMachineStockMovement,
} from "./machine-stock-movements.repository";

export type SaleSafetyBlockerState =
  | "needs_count"
  | "blocked_for_planogram_change"
  | "movement_rejected"
  | "needs_platform_review";

export type MachineStockReconciliationReason =
  | "unknown_slot"
  | "unknown_planogram_version"
  | "inactive_planogram_version"
  | "mapping_mismatch"
  | "movement_id_payload_conflict"
  | "order_context_missing"
  | "order_context_mismatch";

type OrderBoundDispenseMovement = RawMachineStockMovement & {
  movementType: "dispense_succeeded";
};

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
  reconciliation?: {
    reason: MachineStockReconciliationReason;
    platformReview: {
      required: true;
      status: "open";
    };
    saleSafetyBlocker: {
      slotId: string;
      slotSalesState: SaleSafetyBlockerState;
      reason: MachineStockReconciliationReason;
    } | null;
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
      return await responseForExisting(
        this.repository,
        machine.id,
        trustedInput,
        normalized,
        existing,
        payloadHash,
      );
    }

    const reconciliation = await reconciliationForMovement(
      this.repository,
      machine.id,
      trustedInput,
    );
    if (reconciliation) {
      const stored = await this.repository.insertReconciliation({
        machineId: machine.id,
        input: trustedInput,
        normalized,
        payloadHash,
        ...reconciliation,
      });
      return reconciliationResponse(
        trustedInput.movementId,
        stored,
        reconciliation,
      );
    }

    const orderBoundDispenseContext =
      await orderBoundDispenseContextForMovement(
        this.repository,
        machine.id,
        trustedInput,
      );
    if (orderBoundDispenseContext.reconciliation) {
      const stored = await this.repository.insertReconciliation({
        machineId: machine.id,
        input: trustedInput,
        normalized,
        payloadHash,
        ...orderBoundDispenseContext.reconciliation,
      });
      return reconciliationResponse(
        trustedInput.movementId,
        stored,
        orderBoundDispenseContext.reconciliation,
      );
    }

    try {
      const stored = await this.repository.insertAccepted({
        machineId: machine.id,
        input: trustedInput,
        normalized,
        payloadHash,
      });
      await applyAcceptedMovementSideEffects(
        this.repository,
        machine.id,
        trustedInput,
        stored,
        orderBoundDispenseContext.context,
      );
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
      return await responseForExisting(
        this.repository,
        machine.id,
        trustedInput,
        normalized,
        concurrent,
        payloadHash,
      );
    }
  }
}

type OrderBoundDispenseContextResult =
  | {
      context: OrderBoundDispenseConfirmationContext | null;
      reconciliation: null;
    }
  | {
      context: null;
      reconciliation: Omit<
        InsertReconciliationRawMachineStockMovement,
        "machineId" | "input" | "normalized" | "payloadHash"
      >;
    };

async function orderBoundDispenseContextForMovement(
  repository: MachineStockMovementsRepository,
  machineId: string,
  input: RawMachineStockMovement,
): Promise<OrderBoundDispenseContextResult> {
  if (!isOrderBoundDispenseMovement(input)) {
    return { context: null, reconciliation: null };
  }
  if (!input.orderContext) {
    return {
      context: null,
      reconciliation: orderBoundDispenseReconciliation(
        input.slotId,
        "order_context_missing",
      ),
    };
  }

  const context = await repository.getOrderBoundDispenseConfirmationContext(
    machineId,
    input,
  );
  if (!context) {
    return {
      context: null,
      reconciliation: orderBoundDispenseReconciliation(
        input.slotId,
        "order_context_mismatch",
      ),
    };
  }

  return { context, reconciliation: null };
}

async function applyAcceptedMovementSideEffects(
  repository: MachineStockMovementsRepository,
  machineId: string,
  input: RawMachineStockMovement,
  stored: StoredRawMachineStockMovement,
  context: OrderBoundDispenseConfirmationContext | null,
): Promise<void> {
  if (!isOrderBoundDispenseMovement(input) || !context) {
    return;
  }
  await repository.confirmOrderBoundDispenseSucceeded({
    machineId,
    rawMovementId: stored.id,
    input,
    context,
  });
}

function isOrderBoundDispenseMovement(
  input: RawMachineStockMovement,
): input is OrderBoundDispenseMovement {
  return input.movementType === "dispense_succeeded";
}

function orderBoundDispenseReconciliation(
  slotId: string,
  reason: "order_context_missing" | "order_context_mismatch",
): Omit<
  InsertReconciliationRawMachineStockMovement,
  "machineId" | "input" | "normalized" | "payloadHash"
> {
  return {
    reconciliationReason: reason,
    platformReviewStatus: "open",
    saleSafetyBlockerState: "needs_platform_review",
    saleSafetyBlockerSlotId: slotId,
  };
}

async function responseForExisting(
  repository: MachineStockMovementsRepository,
  machineId: string,
  input: RawMachineStockMovement,
  normalized: Record<string, unknown>,
  existing: StoredRawMachineStockMovement,
  payloadHash: string,
): Promise<MachineStockMovementIngestionResponse> {
  if (existing.payloadHash === payloadHash) {
    if (existing.status === "reconciliation") {
      return reconciliationResponse(input.movementId, existing, {
        reconciliationReason: parseReconciliationReason(
          existing.reconciliationReason,
          "unknown_slot",
        ),
        platformReviewStatus: "open",
        saleSafetyBlockerState: parseSaleSafetyBlockerState(
          existing.saleSafetyBlockerState,
        ),
        saleSafetyBlockerSlotId: existing.saleSafetyBlockerSlotId,
      });
    }
    return acceptedResponse(input.movementId, existing, "already_accepted");
  }

  const reconciliation = movementConflictReconciliation(input.slotId);
  const conflict = await repository.insertConflictReconciliation({
    machineId,
    rawMovementId: existing.id,
    input,
    normalized,
    payloadHash,
    ...reconciliation,
  });
  return {
    ...reconciliationResponse(input.movementId, conflict, reconciliation),
    rejection: {
      reason: "movement_id_payload_conflict",
      existingPayloadHash: existing.payloadHash,
      receivedPayloadHash: payloadHash,
    },
  };
}

async function reconciliationForMovement(
  repository: MachineStockMovementsRepository,
  machineId: string,
  input: RawMachineStockMovement,
): Promise<Omit<
  InsertReconciliationRawMachineStockMovement,
  "machineId" | "input" | "normalized" | "payloadHash"
> | null> {
  const context = await repository.getMovementApplicationContext(
    machineId,
    input.planogramVersion,
    input.slotId,
  );

  if (!context.machineSlotKnown) {
    return {
      reconciliationReason: "unknown_slot",
      platformReviewStatus: "open",
      saleSafetyBlockerState: "needs_platform_review",
      saleSafetyBlockerSlotId: input.slotId,
    };
  }
  if (!context.planogramKnown) {
    return {
      reconciliationReason: "unknown_planogram_version",
      platformReviewStatus: "open",
      saleSafetyBlockerState: "blocked_for_planogram_change",
      saleSafetyBlockerSlotId: input.slotId,
    };
  }
  if (!context.planogramActive) {
    return {
      reconciliationReason: "inactive_planogram_version",
      platformReviewStatus: "open",
      saleSafetyBlockerState: "blocked_for_planogram_change",
      saleSafetyBlockerSlotId: input.slotId,
    };
  }
  if (!context.slotInPlanogram) {
    return {
      reconciliationReason: "mapping_mismatch",
      platformReviewStatus: "open",
      saleSafetyBlockerState: "blocked_for_planogram_change",
      saleSafetyBlockerSlotId: input.slotId,
    };
  }
  return null;
}

function movementConflictReconciliation(
  slotId: string,
): Omit<
  InsertReconciliationRawMachineStockMovement,
  "machineId" | "input" | "normalized" | "payloadHash"
> {
  return {
    reconciliationReason: "movement_id_payload_conflict",
    platformReviewStatus: "open",
    saleSafetyBlockerState: "movement_rejected",
    saleSafetyBlockerSlotId: slotId,
  };
}

function reconciliationResponse(
  movementId: string,
  row: StoredRawMachineStockMovement,
  reconciliation: Omit<
    InsertReconciliationRawMachineStockMovement,
    "machineId" | "input" | "normalized" | "payloadHash"
  >,
): MachineStockMovementIngestionResponse {
  return {
    movementId,
    status: "reconciliation",
    acceptedAt: null,
    receipt: {
      rawMovementId: row.id,
      payloadHash: row.payloadHash,
    },
    reconciliation: reconciliationPayload(reconciliation),
  };
}

function reconciliationPayload(
  reconciliation: Omit<
    InsertReconciliationRawMachineStockMovement,
    "machineId" | "input" | "normalized" | "payloadHash"
  >,
): NonNullable<MachineStockMovementIngestionResponse["reconciliation"]> {
  const reason = parseReconciliationReason(
    reconciliation.reconciliationReason,
    "unknown_slot",
  );
  const slotSalesState = parseSaleSafetyBlockerState(
    reconciliation.saleSafetyBlockerState,
  );
  return {
    reason,
    platformReview: {
      required: true,
      status: "open",
    },
    saleSafetyBlocker:
      slotSalesState && reconciliation.saleSafetyBlockerSlotId
        ? {
            slotId: reconciliation.saleSafetyBlockerSlotId,
            slotSalesState,
            reason,
          }
        : null,
  };
}

function parseReconciliationReason(
  value: string | null,
  fallback: MachineStockReconciliationReason,
): MachineStockReconciliationReason {
  switch (value) {
    case null:
      return fallback;
    case "unknown_slot":
    case "unknown_planogram_version":
    case "inactive_planogram_version":
    case "mapping_mismatch":
    case "movement_id_payload_conflict":
    case "order_context_missing":
    case "order_context_mismatch":
      return value;
    default:
      return fallback;
  }
}

function parseSaleSafetyBlockerState(
  value: string | null,
): SaleSafetyBlockerState | null {
  switch (value) {
    case null:
      return null;
    case "needs_count":
    case "blocked_for_planogram_change":
    case "movement_rejected":
    case "needs_platform_review":
      return value;
    default:
      return null;
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
    machineCode: input.machineCode ?? null,
    movementId: input.movementId,
    planogramVersion: input.planogramVersion,
    slotId: input.slotId,
    movementType: input.movementType,
    quantity: input.quantity,
    source: input.source,
    attributedTo: input.attributedTo ?? null,
    orderContext: input.orderContext ?? null,
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
