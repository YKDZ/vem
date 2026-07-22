import type { RawMachineStockMovement } from "@vem/shared";

import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  eq,
  inventoryMovements,
  inventoryReservations,
  inArray,
  isNull,
  machinePlanogramSlots,
  machinePlanogramVersions,
  machineRawStockMovementConflicts,
  machineRawStockMovements,
  machineSlots,
  orderItems,
  orders,
  orderStatusEvents,
  sql,
  vendingCommands,
  type DrizzleClient,
  type DrizzleTransaction,
} from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  lockInventoriesForVendingMutation,
  lockMachineForVendingMutation,
  lockOrderForVendingMutation,
} from "../database/machine-transaction-lock";
import { projectOrderStatus } from "../orders/order-state-projection";
import { RefundsService } from "../refunds/refunds.service";

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

class OrderBoundDispenseConfirmationFailedError extends Error {}

export type MovementApplicationContext = {
  machineSlotKnown: boolean;
  planogramKnown: boolean;
  planogramActive: boolean;
  slotInPlanogram: boolean;
};

export type ActiveAcknowledgedPlanogramSlot = {
  capacity: number;
  inventoryId: string;
  variantId: string;
};

export type OrderBoundDispenseConfirmationContext = {
  orderId: string;
  orderItemId: string;
  inventoryId: string;
  quantity: number;
  vendingCommandId: string;
};

export type ConfirmOrderBoundDispenseInput = {
  machineId: string;
  rawMovementId: string;
  input: RawMachineStockMovement & { movementType: "dispense_succeeded" };
  context: OrderBoundDispenseConfirmationContext;
};

export type AcceptedOrderBoundDispenseMovement = {
  movementId: string;
  orderId: string;
  vendingCommandId: string;
  quantity: number;
  beforeQuantity: number | null;
  afterQuantity: number | null;
  deltaQuantity: number;
};

export type PendingFailedLinePartialRefundDecision = {
  orderId: string;
  orderItemIds: string[];
  amountCents: number;
  metadata: Record<string, unknown>;
};

@Injectable()
export class MachineStockMovementsRepository {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly refundsService: RefundsService,
  ) {}

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

  async buildPendingFailedLinePartialRefundDecision(
    orderId: string,
    metadata: Record<string, unknown>,
    source: DrizzleClient | DrizzleTransaction = this.db,
  ): Promise<PendingFailedLinePartialRefundDecision | null> {
    const lines = await source
      .select({
        id: orderItems.id,
        fulfillmentStatus: orderItems.fulfillmentStatus,
        refundStatus: orderItems.refundStatus,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    if (lines.length === 0) return null;

    const hasOpenLine = lines.some(
      (line) =>
        line.fulfillmentStatus === "pending" ||
        line.fulfillmentStatus === "dispensing",
    );
    if (hasOpenLine) return null;

    const pendingFailedLines = lines.filter(
      (line) =>
        line.fulfillmentStatus === "dispense_failed" &&
        line.refundStatus === "pending",
    );
    const hasDispensedLine = lines.some(
      (line) => line.fulfillmentStatus === "dispensed",
    );
    if (!hasDispensedLine || pendingFailedLines.length === 0) return null;

    return {
      orderId,
      orderItemIds: pendingFailedLines.map((line) => line.id),
      amountCents: pendingFailedLines.reduce(
        (sum, line) => sum + line.unitPriceCents * line.quantity,
        0,
      ),
      metadata,
    };
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

  async getActiveAcknowledgedPlanogramSlot(
    machineId: string,
    planogramVersion: string,
    slotId: string,
  ): Promise<ActiveAcknowledgedPlanogramSlot | null> {
    const [row] = await this.db
      .select({
        capacity: machinePlanogramSlots.capacity,
        inventoryId: machinePlanogramSlots.inventoryId,
        variantId: machinePlanogramSlots.variantId,
      })
      .from(machinePlanogramVersions)
      .innerJoin(
        machinePlanogramSlots,
        eq(
          machinePlanogramSlots.machinePlanogramVersionId,
          machinePlanogramVersions.id,
        ),
      )
      .where(
        and(
          eq(machinePlanogramVersions.machineId, machineId),
          eq(machinePlanogramVersions.planogramVersion, planogramVersion),
          eq(machinePlanogramVersions.status, "active"),
          sql`${machinePlanogramVersions.acknowledgedAt} IS NOT NULL`,
          eq(machinePlanogramSlots.slotId, slotId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getOrderBoundDispenseConfirmationContext(
    machineId: string,
    input: RawMachineStockMovement & { movementType: "dispense_succeeded" },
  ): Promise<OrderBoundDispenseConfirmationContext | null> {
    const orderContext = input.orderContext;
    if (!orderContext || input.quantity <= 0) {
      return null;
    }

    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderItemId: orderItems.id,
        inventoryId: orderItems.inventoryId,
        quantity: orderItems.quantity,
        vendingCommandId: vendingCommands.id,
      })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .innerJoin(
        inventoryReservations,
        and(
          eq(inventoryReservations.orderId, orders.id),
          eq(inventoryReservations.inventoryId, orderItems.inventoryId),
          eq(inventoryReservations.orderItemId, orderItems.id),
        ),
      )
      .innerJoin(
        vendingCommands,
        and(
          eq(vendingCommands.orderId, orders.id),
          eq(vendingCommands.orderItemId, orderItems.id),
        ),
      )
      .where(
        and(
          eq(orders.machineId, machineId),
          eq(orders.orderNo, orderContext.orderNo),
          eq(orderItems.id, orderContext.orderItemId),
          eq(orderItems.inventoryId, orderContext.inventoryId),
          eq(orderItems.slotId, input.slotId),
          sql`${orderItems.quantity} = ${input.quantity}`,
          eq(inventoryReservations.status, "active"),
          sql`${inventoryReservations.quantity} >= ${input.quantity}`,
          eq(vendingCommands.commandNo, orderContext.vendingCommandNo),
          eq(vendingCommands.slotId, input.slotId),
          sql`(${vendingCommands.payloadJson}->>'quantity')::int = ${input.quantity}`,
          sql`${orderItems.productSnapshot}->>'planogramVersion' = ${input.planogramVersion}`,
          sql`${orderItems.productSnapshot}->>'slotId' = ${input.slotId}`,
          sql`${orderItems.productSnapshot}->>'inventoryId' = ${orderContext.inventoryId}`,
          sql`${orderItems.productSnapshot}->>'variantId' = ${orderItems.variantId}::text`,
          sql`${orderItems.productSnapshot}->>'productId' IS NOT NULL`,
          sql`(${orderItems.productSnapshot}->>'vendingCommandQuantity')::int = ${input.quantity}`,
        ),
      )
      .limit(1);

    return row ?? null;
  }

  async findAcceptedOrderBoundDispenseMovement(
    machineId: string,
    orderId: string,
    vendingCommandId: string,
  ): Promise<AcceptedOrderBoundDispenseMovement | null> {
    const [row] = await this.db
      .select({
        movementId: machineRawStockMovements.movementId,
        orderId: orders.id,
        vendingCommandId: vendingCommands.id,
        quantity: machineRawStockMovements.quantity,
        beforeQuantity: sql<
          number | null
        >`(${machineRawStockMovements.payloadJson}->>'beforeQuantity')::int`,
        afterQuantity: sql<
          number | null
        >`(${machineRawStockMovements.payloadJson}->>'afterQuantity')::int`,
        deltaQuantity: inventoryMovements.deltaQty,
      })
      .from(machineRawStockMovements)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderId),
          eq(orders.machineId, machineId),
          eq(
            sql`${machineRawStockMovements.payloadJson}->'orderContext'->>'orderNo'`,
            orders.orderNo,
          ),
        ),
      )
      .innerJoin(
        vendingCommands,
        and(
          eq(vendingCommands.id, vendingCommandId),
          eq(vendingCommands.orderId, orders.id),
          eq(
            sql`${machineRawStockMovements.payloadJson}->'orderContext'->>'vendingCommandNo'`,
            vendingCommands.commandNo,
          ),
        ),
      )
      .innerJoin(
        inventoryMovements,
        and(
          eq(inventoryMovements.orderId, orders.id),
          eq(inventoryMovements.reason, "purchase_confirmed"),
          eq(
            inventoryMovements.note,
            sql`concat('machine_stock_movement:', ${machineRawStockMovements.id})`,
          ),
        ),
      )
      .where(
        and(
          eq(machineRawStockMovements.machineId, machineId),
          eq(machineRawStockMovements.movementType, "dispense_succeeded"),
          eq(machineRawStockMovements.status, "accepted"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async repairAcceptedOrderBoundDispenseCommand(
    machineId: string,
    input: RawMachineStockMovement & { movementType: "dispense_succeeded" },
  ): Promise<boolean> {
    const commandNo = input.orderContext?.vendingCommandNo;
    if (!commandNo) return false;
    return await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(vendingCommands)
        .set({
          status: "succeeded",
          resultAt: new Date(input.occurredAt),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vendingCommands.machineId, machineId),
            eq(vendingCommands.commandNo, commandNo),
            inArray(vendingCommands.status, [
              "pending",
              "sent",
              "acknowledged",
              "result_unknown",
              "timeout",
              "succeeded",
            ]),
          ),
        )
        .returning({ id: vendingCommands.id });
      return Boolean(updated);
    });
  }

  async insertAcceptedWithOrderBoundDispenseConfirmation(
    input: Omit<InsertRawMachineStockMovement, "input"> & {
      input: RawMachineStockMovement & { movementType: "dispense_succeeded" };
      context: OrderBoundDispenseConfirmationContext;
    },
  ): Promise<StoredRawMachineStockMovement | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const stored = await this.insertRawInto(tx, input, {
          status: "accepted",
          reconciliationReason: null,
          platformReviewStatus: null,
          saleSafetyBlockerState: null,
          saleSafetyBlockerSlotId: null,
        });
        await this.confirmOrderBoundDispenseSucceededInTransaction(tx, {
          machineId: input.machineId,
          rawMovementId: stored.id,
          input: input.input,
          context: input.context,
        });
        return stored;
      });
    } catch (error) {
      if (error instanceof OrderBoundDispenseConfirmationFailedError) {
        return null;
      }
      throw error;
    }
  }

  async confirmOrderBoundDispenseSucceeded(
    input: ConfirmOrderBoundDispenseInput,
  ): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.confirmOrderBoundDispenseSucceededInTransaction(tx, input);
        return true;
      });
    } catch (error) {
      if (error instanceof OrderBoundDispenseConfirmationFailedError) {
        return false;
      }
      throw error;
    }
  }

  private async confirmOrderBoundDispenseSucceededInTransaction(
    tx: DrizzleTransaction,
    input: ConfirmOrderBoundDispenseInput,
  ): Promise<void> {
    await lockMachineForVendingMutation(tx, input.machineId);
    try {
      await lockOrderForVendingMutation(tx, input.context.orderId);
      await lockInventoriesForVendingMutation(tx, [input.context.inventoryId]);
    } catch (error) {
      if (error instanceof Error) {
        throw new OrderBoundDispenseConfirmationFailedError(error.message);
      }
      throw error;
    }

    const [claimedCommand] = await tx
      .update(vendingCommands)
      .set({
        status: "succeeded",
        resultAt: new Date(input.input.occurredAt),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(vendingCommands.id, input.context.vendingCommandId),
          inArray(vendingCommands.status, [
            "pending",
            "sent",
            "acknowledged",
            "result_unknown",
            "timeout",
          ]),
        ),
      )
      .returning({ id: vendingCommands.id });
    if (!claimedCommand) {
      throw new OrderBoundDispenseConfirmationFailedError(
        "Vending command is not claimable for success",
      );
    }

    const result = await tx.execute(sql`
      update inventories
      set
        on_hand_qty = on_hand_qty - ${input.context.quantity},
        reserved_qty = reserved_qty - ${input.context.quantity},
        updated_at = now()
      where id = ${input.context.inventoryId}
        and on_hand_qty >= ${input.context.quantity}
        and reserved_qty >= ${input.context.quantity}
        and exists (
          select 1
          from inventory_reservations
          where order_id = ${input.context.orderId}
            and inventory_id = ${input.context.inventoryId}
            and order_item_id = ${input.context.orderItemId}
            and status = 'active'
            and quantity >= ${input.context.quantity}
        )
      returning id
    `);
    if ((result.rowCount ?? 0) !== 1) {
      throw new OrderBoundDispenseConfirmationFailedError(
        "Reserved inventory could not be confirmed",
      );
    }

    const [confirmedReservation] = await tx
      .update(inventoryReservations)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(
        and(
          eq(inventoryReservations.orderId, input.context.orderId),
          eq(inventoryReservations.inventoryId, input.context.inventoryId),
          eq(inventoryReservations.orderItemId, input.context.orderItemId),
          eq(inventoryReservations.status, "active"),
        ),
      )
      .returning({ id: inventoryReservations.id });
    if (!confirmedReservation) {
      throw new OrderBoundDispenseConfirmationFailedError(
        "Inventory reservation could not be confirmed",
      );
    }

    await tx.insert(inventoryMovements).values({
      inventoryId: input.context.inventoryId,
      deltaQty: -input.context.quantity,
      reason: "purchase_confirmed",
      orderId: input.context.orderId,
      note: `machine_stock_movement:${input.rawMovementId}`,
    });

    const [fulfilledOrderItem] = await tx
      .update(orderItems)
      .set({
        fulfillmentStatus: "dispensed",
        refundStatus: "not_required",
        fulfilledAt: new Date(input.input.occurredAt),
      })
      .where(eq(orderItems.id, input.context.orderItemId))
      .returning({ id: orderItems.id });
    if (!fulfilledOrderItem) {
      throw new OrderBoundDispenseConfirmationFailedError(
        "Order item could not be fulfilled",
      );
    }

    await this.syncOrderFulfillmentStateFromLines(tx, {
      orderId: input.context.orderId,
      reason: "machine_stock_dispense_succeeded",
      metadata: { rawMovementId: input.rawMovementId },
      dispensedAt: new Date(input.input.occurredAt),
    });
    const partialRefund =
      await this.buildPendingFailedLinePartialRefundDecision(
        input.context.orderId,
        { rawMovementId: input.rawMovementId },
        tx,
      );
    if (partialRefund) {
      await this.refundsService.stageAutomaticPartialRefund(tx, partialRefund);
    }
  }

  private async syncOrderFulfillmentStateFromLines(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      reason: string;
      metadata?: Record<string, unknown>;
      dispensedAt?: Date;
    },
  ): Promise<void> {
    const lines = await tx
      .select({ fulfillmentStatus: orderItems.fulfillmentStatus })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId));
    if (lines.length === 0) return;

    const dispensed = lines.filter(
      (line) => line.fulfillmentStatus === "dispensed",
    ).length;
    const failed = lines.filter(
      (line) => line.fulfillmentStatus === "dispense_failed",
    ).length;
    const manual = lines.some(
      (line) => line.fulfillmentStatus === "manual_handling",
    );
    const fulfillmentState = manual
      ? "manual_handling"
      : dispensed === lines.length
        ? "dispensed"
        : failed === lines.length
          ? "dispense_failed"
          : dispensed > 0 && failed > 0
            ? "partial_dispensed"
            : failed > 0
              ? "dispense_failed"
              : "dispensing";

    const [currentOrder] = await tx
      .select({
        status: orders.status,
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId));
    if (!currentOrder || currentOrder.fulfillmentState === fulfillmentState) {
      return;
    }

    const projectedStatus = projectOrderStatus({
      paymentState: currentOrder.paymentState,
      fulfillmentState,
    });
    await tx
      .update(orders)
      .set({
        status: projectedStatus,
        fulfillmentState,
        dispensedAt:
          fulfillmentState === "dispensed"
            ? (input.dispensedAt ?? new Date())
            : null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, input.orderId));
    await tx.insert(orderStatusEvents).values({
      orderId: input.orderId,
      fromStatus: currentOrder.status,
      toStatus: projectedStatus,
      reason: input.reason,
      metadata: input.metadata ?? null,
    });
  }

  async applyTrustedFieldStockMovement(input: {
    machineId: string;
    rawMovementId: string;
    input: RawMachineStockMovement;
  }): Promise<boolean> {
    const snapshot = input.input.slotMappingSnapshot;
    if (
      !snapshot?.inventoryId ||
      !snapshot.variantId ||
      input.input.beforeQuantity === undefined ||
      input.input.afterQuantity === undefined
    ) {
      return false;
    }
    const inventoryId = snapshot.inventoryId;
    const variantId = snapshot.variantId;
    const beforeQuantity = input.input.beforeQuantity;
    const afterQuantity = input.input.afterQuantity;
    const deltaQty = afterQuantity - beforeQuantity;

    return await this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        update inventories
        set
          on_hand_qty = ${afterQuantity},
          updated_at = now()
        where id = ${inventoryId}
          and machine_id = ${input.machineId}
          and slot_id = ${input.input.slotId}
          and variant_id = ${variantId}
          and on_hand_qty = ${beforeQuantity}
        returning id
      `);
      if ((result.rowCount ?? 0) !== 1) {
        return false;
      }

      await tx.insert(inventoryMovements).values({
        inventoryId,
        deltaQty,
        reason: "hardware_sync",
        note: `machine_stock_movement:${input.rawMovementId}`,
      });
      return true;
    });
  }

  async restoreSlotAfterAcceptedLocalMaintenance(input: {
    machineId: string;
    slotId: string;
  }): Promise<void> {
    await this.db
      .update(machineSlots)
      .set({ status: "enabled", updatedAt: new Date() })
      .where(
        and(
          eq(machineSlots.machineId, input.machineId),
          eq(machineSlots.id, input.slotId),
          eq(machineSlots.status, "faulted"),
          isNull(machineSlots.deletedAt),
        ),
      );
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
    return await this.insertRawInto(this.db, input, status);
  }

  private async insertRawInto(
    db: DrizzleClient | DrizzleTransaction,
    input: InsertRawMachineStockMovement,
    status: {
      status: "accepted" | "reconciliation";
      reconciliationReason: string | null;
      platformReviewStatus: string | null;
      saleSafetyBlockerState: string | null;
      saleSafetyBlockerSlotId: string | null;
    },
  ): Promise<StoredRawMachineStockMovement> {
    const [row] = await db
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
