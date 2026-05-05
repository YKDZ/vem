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
  productVariants,
  products,
  sql,
  type DrizzleClient,
  type DrizzleTransaction,
  type SQL,
} from "@vem/db";
import {
  adjustInventorySchema,
  createInventorySchema,
  inventoryQuerySchema,
  pageQuerySchema,
  refillInventorySchema,
  type HardwareErrorCode,
} from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { NotificationsService } from "../notifications/notifications.service";

type InventoryQuery = z.infer<typeof inventoryQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type RefillInventoryInput = z.infer<typeof refillInventorySchema>;
type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
type CreateInventoryInput = z.infer<typeof createInventorySchema>;
type PageQueryInput = z.infer<typeof pageQuerySchema>;

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly notificationsService: NotificationsService,
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
        slotCode: machineSlots.slotCode,
        variantId: inventories.variantId,
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

    return toPageResult(items, query, Number(totalRow.total));
  }

  async refill(adminUserId: string, input: RefillInventoryInput) {
    return await this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select()
        .from(inventories)
        .where(eq(inventories.id, input.inventoryId));
      if (!inventory) {
        throw new NotFoundException("Inventory not found");
      }

      const [updated] = await tx
        .update(inventories)
        .set({
          onHandQty: inventory.onHandQty + input.quantity,
          updatedAt: new Date(),
        })
        .where(eq(inventories.id, inventory.id))
        .returning();

      await tx.insert(inventoryMovements).values({
        inventoryId: inventory.id,
        deltaQty: input.quantity,
        reason: "refill",
        operatorAdminUserId: adminUserId,
        note: input.note ?? null,
      });

      return updated;
    });
  }

  async adjust(adminUserId: string, input: AdjustInventoryInput) {
    return await this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select()
        .from(inventories)
        .where(eq(inventories.id, input.inventoryId));
      if (!inventory) {
        throw new NotFoundException("Inventory not found");
      }

      const nextOnHandQty = inventory.onHandQty + input.deltaQty;
      if (nextOnHandQty < 0) {
        throw new ConflictException("Inventory cannot be negative");
      }
      if (nextOnHandQty < inventory.reservedQty) {
        throw new ConflictException(
          "Inventory cannot be below reserved quantity",
        );
      }

      const [updated] = await tx
        .update(inventories)
        .set({ onHandQty: nextOnHandQty, updatedAt: new Date() })
        .where(eq(inventories.id, inventory.id))
        .returning();

      await tx.insert(inventoryMovements).values({
        inventoryId: inventory.id,
        deltaQty: input.deltaQty,
        reason: "adjust",
        operatorAdminUserId: adminUserId,
        note: input.note,
      });

      return updated;
    });
  }

  async listMovements(query: PageQueryInput) {
    const items = await this.db
      .select()
      .from(inventoryMovements)
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(inventoryMovements);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async createInventory(adminUserId: string, input: CreateInventoryInput) {
    return await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(inventories)
        .values({
          machineId: input.machineId,
          slotId: input.slotId,
          variantId: input.variantId,
          onHandQty: input.onHandQty,
          reservedQty: input.reservedQty,
          lowStockThreshold: input.lowStockThreshold,
        })
        .returning();

      await tx.insert(inventoryMovements).values({
        inventoryId: created.id,
        deltaQty: input.onHandQty,
        reason: "adjust",
        operatorAdminUserId: adminUserId,
        note: input.note ?? "initial inventory binding",
      });

      return created;
    });
  }

  async reserveForOrder(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
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
    input: { orderId: string; inventoryId: string; quantity: number },
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
      inventoryId: string;
      quantity: number;
      reason: "payment_failed" | "payment_expired" | "canceled";
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

  async compensateDispenseFailure(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      slotId: string;
      errorCode: HardwareErrorCode | null;
      message: string;
    },
  ): Promise<{ restoredQuantity: number; slotFaulted: boolean }> {
    const shouldRestoreInventory = input.errorCode === "NO_DROP";
    const shouldFaultSlot =
      input.errorCode === "JAMMED" ||
      input.errorCode === "DOOR_OPEN" ||
      input.errorCode === "MOTOR_TIMEOUT" ||
      input.errorCode === "UNKNOWN" ||
      input.errorCode === null;

    const rows = await tx
      .select({
        inventoryId: orderItems.inventoryId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.orderId, input.orderId),
          eq(orderItems.slotId, input.slotId),
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
