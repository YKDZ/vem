import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inventories,
  inventoryMovements,
  inventoryReservations,
  machineSlots,
  machines,
  orderItems,
  orders,
  productVariants,
  products,
  sql,
  type DrizzleClient,
  type DrizzleTransaction,
  type SQL,
} from "@vem/db";
import {
  adjustInventorySchema,
  adminInventoryMovementListQuerySchema,
  createInventorySchema,
  inventoryQuerySchema,
  pageQuerySchema,
  type HardwareErrorCode,
} from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { HardwareErrorPoliciesService } from "../hardware-error-policies/hardware-error-policies.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  mapAdjustInventoryDtoToMovementInsert,
  mapCreateInventoryDtoToInsert,
  mapCreateInventoryDtoToMovementInsert,
  toAdminInventoryMovementResponse,
  toAdminInventoryResponse,
} from "./inventory.contract-mappers";

type InventoryQuery = z.infer<typeof inventoryQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
type CreateInventoryInput = z.infer<typeof createInventorySchema>;
type PageQueryInput = z.infer<typeof adminInventoryMovementListQuerySchema>;

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly notificationsService: NotificationsService,
    private readonly hardwareErrorPoliciesService: HardwareErrorPoliciesService,
  ) {}

  async listInventories(query: InventoryQuery) {
    const filters: SQL[] = [];
    if (query.machineId) {
      filters.push(eq(inventories.machineId, query.machineId));
    }
    if (query.slotId) {
      filters.push(eq(inventories.slotId, query.slotId));
    }
    if (query.variantId) {
      filters.push(eq(inventories.variantId, query.variantId));
    }
    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const items = await this.db
      .select({
        id: inventories.id,
        machineId: inventories.machineId,
        machineCode: machines.code,
        slotId: inventories.slotId,
        variantId: inventories.variantId,
        productId: products.id,
        sku: productVariants.sku,
        productName: products.name,
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
        lowStockThreshold: inventories.lowStockThreshold,
        availableQty: sql<number>`${inventories.onHandQty} - ${inventories.reservedQty}`,
        createdAt: inventories.createdAt,
        updatedAt: inventories.updatedAt,
      })
      .from(inventories)
      .innerJoin(machines, eq(machines.id, inventories.machineId))
      .innerJoin(machineSlots, eq(machineSlots.id, inventories.slotId))
      .innerJoin(productVariants, eq(productVariants.id, inventories.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(whereClause)
      .orderBy(desc(inventories.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(inventories)
      .where(whereClause);

    return toPageResult(
      items.map(toAdminInventoryResponse),
      query,
      Number(totalRow.total),
    );
  }

  async adjust(adminUserId: string, input: AdjustInventoryInput) {
    return await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(inventories)
        .set({
          onHandQty: sql`${inventories.onHandQty} + ${input.deltaQty}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventories.id, input.inventoryId),
            sql`${inventories.onHandQty} + ${input.deltaQty} >= 0`,
            sql`${inventories.onHandQty} + ${input.deltaQty} >= ${inventories.reservedQty}`,
          ),
        )
        .returning();
      if (!updated) {
        const [exists] = await tx
          .select({ id: inventories.id })
          .from(inventories)
          .where(eq(inventories.id, input.inventoryId))
          .limit(1);
        if (!exists) throw new NotFoundException("Inventory not found");
        throw new ConflictException(
          "Adjustment would make inventory negative or below reserved quantity",
        );
      }

      await tx
        .insert(inventoryMovements)
        .values(mapAdjustInventoryDtoToMovementInsert(adminUserId, input));

      return toAdminInventoryResponse(updated);
    });
  }

  async listMovements(query: PageQueryInput) {
    const whereClause = query.inventoryId
      ? eq(inventoryMovements.inventoryId, query.inventoryId)
      : undefined;
    const items = await this.db
      .select({
        id: inventoryMovements.id,
        inventoryId: inventoryMovements.inventoryId,
        deltaQty: inventoryMovements.deltaQty,
        reason: inventoryMovements.reason,
        orderId: inventoryMovements.orderId,
        orderNo: orders.orderNo,
        operatorAdminUserId: inventoryMovements.operatorAdminUserId,
        note: inventoryMovements.note,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .leftJoin(orders, eq(orders.id, inventoryMovements.orderId))
      .where(whereClause)
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(inventoryMovements)
      .where(whereClause);

    return toPageResult(
      items.map(toAdminInventoryMovementResponse),
      query,
      Number(totalRow.total),
    );
  }

  async createInventory(adminUserId: string, input: CreateInventoryInput) {
    return await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(inventories)
        .values(mapCreateInventoryDtoToInsert(input))
        .returning();

      await tx
        .insert(inventoryMovements)
        .values(
          mapCreateInventoryDtoToMovementInsert(adminUserId, created.id, input),
        );

      return toAdminInventoryResponse(created);
    });
  }

  async reserveForOrder(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      orderItemId?: string;
      inventoryId: string;
      quantity: number;
      expiresAt: Date;
    },
  ): Promise<void> {
    const result = await tx.execute(sql`
      update inventories
      set reserved_qty = reserved_qty + ${input.quantity}, updated_at = now()
      where id = ${input.inventoryId}
        and on_hand_qty - reserved_qty >= ${input.quantity}
      returning id
    `);
    if ((result.rowCount ?? 0) !== 1) {
      throw new ConflictException("Inventory is not available");
    }

    await tx.insert(inventoryReservations).values({
      orderId: input.orderId,
      inventoryId: input.inventoryId,
      orderItemId: input.orderItemId ?? null,
      quantity: input.quantity,
      status: "active",
      expiresAt: input.expiresAt,
    });

    await tx.insert(inventoryMovements).values({
      inventoryId: input.inventoryId,
      deltaQty: 0,
      reason: "purchase_reserved",
      orderId: input.orderId,
    });
  }

  async confirmReservation(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      orderItemId?: string | null;
      inventoryId: string;
      quantity: number;
    },
  ): Promise<void> {
    const [reservation] = await tx
      .select({
        id: inventoryReservations.id,
        quantity: inventoryReservations.quantity,
      })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.orderId, input.orderId),
          eq(inventoryReservations.inventoryId, input.inventoryId),
          input.orderItemId
            ? eq(inventoryReservations.orderItemId, input.orderItemId)
            : undefined,
          eq(inventoryReservations.status, "active"),
        ),
      )
      .limit(1);
    if (!reservation) {
      return;
    }

    const quantity = Math.min(input.quantity, reservation.quantity);
    const result = await tx.execute(sql`
      update inventories
      set
        on_hand_qty = on_hand_qty - ${quantity},
        reserved_qty = reserved_qty - ${quantity},
        updated_at = now()
      where id = ${input.inventoryId}
        and on_hand_qty >= ${quantity}
        and reserved_qty >= ${quantity}
      returning id
    `);
    if ((result.rowCount ?? 0) !== 1) {
      throw new ConflictException("Inventory confirmation failed");
    }

    await tx
      .update(inventoryReservations)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(eq(inventoryReservations.id, reservation.id));

    await tx.insert(inventoryMovements).values({
      inventoryId: input.inventoryId,
      deltaQty: -quantity,
      reason: "purchase_confirmed",
      orderId: input.orderId,
    });

    await this.checkAndCreateLowStockNotification(tx, input.inventoryId);
  }

  async releaseReservation(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      orderItemId?: string | null;
      inventoryId: string;
      quantity: number;
      reason:
        | "payment_failed"
        | "payment_expired"
        | "canceled"
        | "dispense_failed";
    },
  ): Promise<void> {
    const [reservation] = await tx
      .select({
        id: inventoryReservations.id,
        quantity: inventoryReservations.quantity,
      })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.orderId, input.orderId),
          eq(inventoryReservations.inventoryId, input.inventoryId),
          input.orderItemId
            ? eq(inventoryReservations.orderItemId, input.orderItemId)
            : undefined,
          eq(inventoryReservations.status, "active"),
        ),
      )
      .limit(1);
    if (!reservation) {
      return;
    }

    const quantity = Math.min(input.quantity, reservation.quantity);
    const result = await tx.execute(sql`
      update inventories
      set reserved_qty = reserved_qty - ${quantity}, updated_at = now()
      where id = ${input.inventoryId}
        and reserved_qty >= ${quantity}
      returning id
    `);
    if ((result.rowCount ?? 0) !== 1) {
      throw new ConflictException("Inventory reservation release failed");
    }

    await tx
      .update(inventoryReservations)
      .set({ status: "released", updatedAt: new Date() })
      .where(eq(inventoryReservations.id, reservation.id));

    await tx.insert(inventoryMovements).values({
      inventoryId: input.inventoryId,
      deltaQty: 0,
      reason: "reservation_released",
      orderId: input.orderId,
      note: input.reason,
    });
  }

  async restoreConfirmedOrderItemsForDispatchFailure(
    tx: DrizzleTransaction,
    input: { orderId: string; note: string },
  ): Promise<{ restoredQuantity: number }> {
    const existing = await tx
      .select({ total: count() })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.orderId, input.orderId),
          eq(inventoryMovements.reason, "refund_return"),
          eq(inventoryMovements.note, input.note),
        ),
      );
    if (Number(existing[0]?.total ?? 0) > 0) {
      return { restoredQuantity: 0 };
    }

    const rows = await tx
      .select({
        inventoryId: orderItems.inventoryId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId));

    let restoredQuantity = 0;
    await rows.reduce<Promise<void>>(async (previous, row) => {
      await previous;
      await tx.execute(sql`
        update inventories
        set on_hand_qty = on_hand_qty + ${row.quantity}, updated_at = now()
        where id = ${row.inventoryId}
      `);
      await tx.insert(inventoryMovements).values({
        inventoryId: row.inventoryId,
        deltaQty: row.quantity,
        reason: "refund_return",
        orderId: input.orderId,
        note: input.note,
      });
      restoredQuantity += row.quantity;
    }, Promise.resolve());

    return { restoredQuantity };
  }

  async releaseAffectedReservationForDispenseFailure(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      orderItemId?: string | null;
      slotId: string;
      errorCode: HardwareErrorCode | null;
      message: string;
    },
  ): Promise<{
    releasedQuantity: number;
    slotFaulted: boolean;
    slotSalesState: "suspect" | "frozen";
  }> {
    const policy = await this.hardwareErrorPoliciesService.getPolicy(
      input.errorCode,
    );
    const rows = await tx
      .select({
        inventoryId: orderItems.inventoryId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.orderId, input.orderId),
          input.orderItemId
            ? eq(orderItems.id, input.orderItemId)
            : eq(orderItems.slotId, input.slotId),
        ),
      );

    let releasedQuantity = 0;
    await rows.reduce<Promise<void>>(async (previous, row) => {
      await previous;
      await this.releaseReservation(tx, {
        orderId: input.orderId,
        orderItemId: input.orderItemId ?? null,
        inventoryId: row.inventoryId,
        quantity: row.quantity,
        reason: "dispense_failed",
      });
      releasedQuantity += row.quantity;
    }, Promise.resolve());

    if (policy.faultSlot) {
      await tx
        .update(machineSlots)
        .set({ status: "faulted", updatedAt: new Date() })
        .where(eq(machineSlots.id, input.slotId));
    }

    return {
      releasedQuantity,
      slotFaulted: policy.faultSlot,
      slotSalesState: policy.faultSlot ? "frozen" : "suspect",
    };
  }

  async compensateDispenseFailure(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      orderItemId?: string | null;
      slotId: string;
      errorCode: HardwareErrorCode | null;
      message: string;
    },
  ): Promise<{ restoredQuantity: number; slotFaulted: boolean }> {
    const policy = await this.hardwareErrorPoliciesService.getPolicy(
      input.errorCode,
    );
    const shouldRestoreInventory = policy.restoreInventory;
    const shouldFaultSlot = policy.faultSlot;

    const rows = await tx
      .select({
        inventoryId: orderItems.inventoryId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.orderId, input.orderId),
          input.orderItemId
            ? eq(orderItems.id, input.orderItemId)
            : eq(orderItems.slotId, input.slotId),
        ),
      );

    let restoredQuantity = 0;
    if (shouldRestoreInventory) {
      await rows.reduce<Promise<void>>(async (previous, row) => {
        await previous;
        await tx.execute(sql`
          update inventories
          set on_hand_qty = on_hand_qty + ${row.quantity}, updated_at = now()
          where id = ${row.inventoryId}
        `);
        await tx.insert(inventoryMovements).values({
          inventoryId: row.inventoryId,
          deltaQty: row.quantity,
          reason: "refund_return",
          orderId: input.orderId,
          note: `dispense_failed:${input.errorCode}:${input.message}`,
        });
        restoredQuantity += row.quantity;
      }, Promise.resolve());
    }

    if (shouldFaultSlot) {
      await tx
        .update(machineSlots)
        .set({ status: "faulted", updatedAt: new Date() })
        .where(eq(machineSlots.id, input.slotId));
    }

    return { restoredQuantity, slotFaulted: shouldFaultSlot };
  }

  private async checkAndCreateLowStockNotification(
    tx: DrizzleTransaction,
    inventoryId: string,
  ): Promise<void> {
    const [inventory] = await tx
      .select({
        machineId: inventories.machineId,
        slotId: inventories.slotId,
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
        lowStockThreshold: inventories.lowStockThreshold,
      })
      .from(inventories)
      .innerJoin(machineSlots, eq(machineSlots.id, inventories.slotId))
      .innerJoin(machines, eq(machines.id, inventories.machineId))
      .where(eq(inventories.id, inventoryId));
    if (!inventory) {
      return;
    }

    const availableQty = inventory.onHandQty - inventory.reservedQty;
    if (availableQty <= inventory.lowStockThreshold) {
      await this.notificationsService.createLowStockNotification(tx, {
        machineId: inventory.machineId,
        slotId: inventory.slotId,
        availableQty,
      });
    }
  }
}
