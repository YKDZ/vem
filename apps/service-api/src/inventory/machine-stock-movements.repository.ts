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
import { projectOrderStatus } from "../orders/order-state-projection";

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
        ),
      )
      .innerJoin(vendingCommands, eq(vendingCommands.orderId, orders.id))
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
          sql`${orderItems.productSnapshot}->>'slotCode' = ${vendingCommands.payloadJson}->'slot'->>'slotCode'`,
          sql`(${orderItems.productSnapshot}->>'vendingCommandQuantity')::int = ${input.quantity}`,
        ),
      )
      .limit(1);

    return row ?? null;
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
        const confirmed =
          await this.confirmOrderBoundDispenseSucceededInTransaction(tx, {
            machineId: input.machineId,
            rawMovementId: stored.id,
            input: input.input,
            context: input.context,
          });
        if (!confirmed) {
          throw new OrderBoundDispenseConfirmationFailedError(
            "Order-bound dispense confirmation failed",
          );
        }
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
    return await this.db.transaction(async (tx) =>
      this.confirmOrderBoundDispenseSucceededInTransaction(tx, input),
    );
  }

  private async confirmOrderBoundDispenseSucceededInTransaction(
    tx: DrizzleTransaction,
    input: ConfirmOrderBoundDispenseInput,
  ): Promise<boolean> {
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
            and status = 'active'
            and quantity >= ${input.context.quantity}
        )
      returning id
    `);
    if ((result.rowCount ?? 0) !== 1) {
      return false;
    }

    await tx
      .update(inventoryReservations)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(
        and(
          eq(inventoryReservations.orderId, input.context.orderId),
          eq(inventoryReservations.inventoryId, input.context.inventoryId),
          eq(inventoryReservations.status, "active"),
        ),
      );

    await tx.insert(inventoryMovements).values({
      inventoryId: input.context.inventoryId,
      deltaQty: -input.context.quantity,
      reason: "purchase_confirmed",
      orderId: input.context.orderId,
      note: `machine_stock_movement:${input.rawMovementId}`,
    });

    await tx
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
            "sent",
            "acknowledged",
            "result_unknown",
            "timeout",
            "succeeded",
          ]),
        ),
      );

    const [currentOrder] = await tx
      .select({
        status: orders.status,
        paymentState: orders.paymentState,
      })
      .from(orders)
      .where(eq(orders.id, input.context.orderId));
    if (currentOrder) {
      const projectedStatus = projectOrderStatus({
        paymentState: currentOrder.paymentState,
        fulfillmentState: "dispensed",
      });
      await tx
        .update(orders)
        .set({
          status: projectedStatus,
          fulfillmentState: "dispensed",
          dispensedAt: new Date(input.input.occurredAt),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, input.context.orderId));
      if (currentOrder.status !== projectedStatus) {
        await tx.insert(orderStatusEvents).values({
          orderId: input.context.orderId,
          fromStatus: currentOrder.status,
          toStatus: projectedStatus,
          reason: "machine_stock_dispense_succeeded",
          metadata: { rawMovementId: input.rawMovementId },
        });
      }
    }

    return true;
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
