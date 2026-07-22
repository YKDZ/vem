import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inventories,
  inventoryMovements,
  machineRawStockMovementConflicts,
  machineRawStockMovements,
  machineSlots,
  machines,
  orders,
  productVariants,
  products,
  sql,
  type DrizzleClient,
  type DrizzleTransaction,
  type SQL,
  vendingCommands,
} from "@vem/db";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

export type StockReconciliationCaseRow = {
  id: string;
  caseTable:
    | "machine_raw_stock_movements"
    | "machine_raw_stock_movement_conflicts";
  rawMovementId: string | null;
  machineId: string;
  machineCode: string;
  movementId: string;
  planogramVersion: string;
  slotId: string;
  slotDisplayLabel?: string | null;
  movementType: string;
  quantity: number;
  beforeQuantity: number | null;
  afterQuantity: number | null;
  source: string;
  attributedTo: string | null;
  occurredAt: Date;
  receivedAt: Date;
  status: string;
  reconciliationReason: string | null;
  platformReviewStatus: string | null;
  saleSafetyBlockerState: string | null;
  saleSafetyBlockerSlotId: string | null;
  payloadJson: Record<string, unknown>;
  normalizedJson: Record<string, unknown>;
  inventoryId: string | null;
  productName: string | null;
  sku: string | null;
  onHandQty: number | null;
  reservedQty: number | null;
  slotStatus: string | null;
  linkedOrderId: string | null;
  linkedOrderNo: string | null;
  linkedCommandId: string | null;
  linkedCommandNo: string | null;
};

export type StockReconciliationPageQuery = {
  page: number;
  pageSize: number;
  machineId?: string;
};

export type StockReconciliationResolveInput = {
  action: "reject_machine_stock" | "manual_correct";
  note: string;
  clearBlocker?: boolean;
  correctedOnHandQty?: number;
  adminUserId: string;
};

export type StockReconciliationResolveResult = {
  case: StockReconciliationCaseRow;
  previousCase: StockReconciliationCaseRow;
  inventoryMovement: {
    inventoryId: string;
    deltaQty: number;
    reason: string;
    note: string;
  } | null;
  clearedBlocker: boolean;
};

export abstract class StockReconciliationRepository {
  abstract listOpenCases(query: StockReconciliationPageQuery): Promise<{
    items: StockReconciliationCaseRow[];
    total: number;
    page: number;
    pageSize: number;
  }>;

  abstract findCaseDetail(
    id: string,
  ): Promise<StockReconciliationCaseRow | null>;

  abstract resolveCase(
    id: string,
    input: StockReconciliationResolveInput,
  ): Promise<StockReconciliationResolveResult | null>;
}

@Injectable()
export class DrizzleStockReconciliationRepository extends StockReconciliationRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {
    super();
  }

  async listOpenCases(query: StockReconciliationPageQuery): Promise<{
    items: StockReconciliationCaseRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const rawWhereClause = rawStockReconciliationWhere(query);
    const conflictWhereClause = conflictStockReconciliationWhere(query);
    const fetchLimit = getOffset(query) + query.pageSize;
    const [rawRows, conflictRows] = await Promise.all([
      this.rawCaseSelection()
        .where(rawWhereClause)
        .orderBy(desc(machineRawStockMovements.receivedAt))
        .limit(fetchLimit),
      this.conflictCaseSelection()
        .where(conflictWhereClause)
        .orderBy(desc(machineRawStockMovementConflicts.receivedAt))
        .limit(fetchLimit),
    ]);
    const [rawTotalRow] = await this.db
      .select({ total: count() })
      .from(machineRawStockMovements)
      .where(rawWhereClause);
    const [conflictTotalRow] = await this.db
      .select({ total: count() })
      .from(machineRawStockMovementConflicts)
      .where(conflictWhereClause);
    const rows = [...rawRows, ...conflictRows]
      .map(toCaseRow)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(getOffset(query), getOffset(query) + query.pageSize);
    const total = Number(rawTotalRow.total) + Number(conflictTotalRow.total);

    return toPageResult(rows, query, total);
  }

  async findCaseDetail(id: string): Promise<StockReconciliationCaseRow | null> {
    return await this.findCaseById(this.db, id, true);
  }

  async resolveCase(
    id: string,
    input: StockReconciliationResolveInput,
  ): Promise<StockReconciliationResolveResult | null> {
    return await this.db.transaction(async (tx) => {
      const current = await this.findCaseById(tx, id, true);
      if (!current || current.platformReviewStatus !== "open") {
        return null;
      }

      const nextOnHandQty =
        input.action === "manual_correct"
          ? input.correctedOnHandQty
          : undefined;

      if (
        input.action === "manual_correct" &&
        (!current.inventoryId ||
          nextOnHandQty === null ||
          nextOnHandQty === undefined)
      ) {
        throw new ConflictException(
          "Stock reconciliation case cannot determine target inventory quantity",
        );
      }

      if (
        nextOnHandQty !== null &&
        nextOnHandQty !== undefined &&
        nextOnHandQty < (current.reservedQty ?? 0)
      ) {
        throw new ConflictException(
          "Resolution would make inventory on-hand quantity below reserved quantity",
        );
      }

      const nextStatus =
        input.action === "reject_machine_stock" ? "rejected" : "accepted";
      const claimed =
        current.caseTable === "machine_raw_stock_movements"
          ? await tx.execute(sql`
              update ${machineRawStockMovements}
              set
                status = ${nextStatus},
                platform_review_status = 'resolved',
                updated_at = now()
              where id = ${id}
                and status = 'reconciliation'
                and platform_review_status = 'open'
              returning id
            `)
          : await tx.execute(sql`
              update ${machineRawStockMovementConflicts}
              set platform_review_status = 'resolved'
              where id = ${id}
                and status = 'reconciliation'
                and platform_review_status = 'open'
              returning id
            `);
      if ((claimed.rowCount ?? 0) !== 1) {
        return null;
      }

      let inventoryMovement: StockReconciliationResolveResult["inventoryMovement"] =
        null;

      if (
        current.inventoryId &&
        nextOnHandQty !== null &&
        nextOnHandQty !== undefined
      ) {
        const previousOnHandQty = current.onHandQty ?? 0;
        const deltaQty = nextOnHandQty - previousOnHandQty;
        const result = await tx.execute(sql`
          update inventories
          set on_hand_qty = ${nextOnHandQty}, updated_at = now()
          where id = ${current.inventoryId}
            and on_hand_qty = ${previousOnHandQty}
          returning id
        `);
        if ((result.rowCount ?? 0) !== 1) {
          throw new ConflictException(
            "Inventory changed while resolving stock reconciliation case",
          );
        }
        const reason = "adjust";
        await tx.insert(inventoryMovements).values({
          inventoryId: current.inventoryId,
          deltaQty,
          reason,
          operatorAdminUserId: input.adminUserId,
          note: input.note,
        });
        inventoryMovement = {
          inventoryId: current.inventoryId,
          deltaQty,
          reason,
          note: input.note,
        };
      }

      const clearedBlocker = input.clearBlocker
        ? await this.clearResolvedCaseBlocker(tx, current)
        : false;
      const fresh = await this.findCaseById(tx, id, false);

      return {
        case: fresh ?? current,
        previousCase: current,
        inventoryMovement,
        clearedBlocker,
      };
    });
  }

  private async findCaseById(
    db: DrizzleClient | DrizzleTransaction,
    id: string,
    openOnly: boolean,
  ): Promise<StockReconciliationCaseRow | null> {
    const rawFilters: SQL[] = [eq(machineRawStockMovements.id, id)];
    if (openOnly) {
      rawFilters.push(
        eq(machineRawStockMovements.status, "reconciliation"),
        eq(machineRawStockMovements.platformReviewStatus, "open"),
      );
    }
    const [rawRow] = await this.rawCaseSelection(db)
      .where(and(...rawFilters))
      .limit(1);
    if (rawRow) return toCaseRow(rawRow);

    const conflictFilters: SQL[] = [
      eq(machineRawStockMovementConflicts.id, id),
    ];
    if (openOnly) {
      conflictFilters.push(
        eq(machineRawStockMovementConflicts.status, "reconciliation"),
        eq(machineRawStockMovementConflicts.platformReviewStatus, "open"),
      );
    }
    const [conflictRow] = await this.conflictCaseSelection(db)
      .where(and(...conflictFilters))
      .limit(1);
    return conflictRow ? toCaseRow(conflictRow) : null;
  }

  private async clearResolvedCaseBlocker(
    tx: DrizzleTransaction,
    current: StockReconciliationCaseRow,
  ): Promise<boolean> {
    const blockerSlotId = current.saleSafetyBlockerSlotId;
    if (!blockerSlotId || !current.saleSafetyBlockerState) return false;

    const result = await tx.execute(sql`
      update ${machineSlots}
      set status = 'enabled', updated_at = now()
      where id = ${blockerSlotId}
        and machine_id = ${current.machineId}
        and status = 'faulted'
        and deleted_at is null
        and not exists (
          select 1
          from ${machineRawStockMovements}
          where machine_id = ${current.machineId}
            and sale_safety_blocker_slot_id = ${blockerSlotId}
            and status = 'reconciliation'
            and platform_review_status = 'open'
            and sale_safety_blocker_state is not null
        )
        and not exists (
          select 1
          from ${machineRawStockMovementConflicts}
          where machine_id = ${current.machineId}
            and sale_safety_blocker_slot_id = ${blockerSlotId}
            and status = 'reconciliation'
            and platform_review_status = 'open'
            and sale_safety_blocker_state is not null
        )
      returning id
    `);
    return (result.rowCount ?? 0) === 1;
  }

  private rawCaseSelection(db: DrizzleClient | DrizzleTransaction = this.db) {
    return db
      .select({
        id: machineRawStockMovements.id,
        caseTable: sql<"machine_raw_stock_movements">`'machine_raw_stock_movements'`,
        rawMovementId: sql<string | null>`null`,
        machineId: machineRawStockMovements.machineId,
        machineCode: machines.code,
        movementId: machineRawStockMovements.movementId,
        planogramVersion: machineRawStockMovements.planogramVersion,
        slotId: machineRawStockMovements.slotId,
        movementType: machineRawStockMovements.movementType,
        quantity: machineRawStockMovements.quantity,
        beforeQuantity: sql<
          number | null
        >`(${machineRawStockMovements.payloadJson}->>'beforeQuantity')::int`,
        afterQuantity: sql<
          number | null
        >`(${machineRawStockMovements.payloadJson}->>'afterQuantity')::int`,
        source: machineRawStockMovements.source,
        attributedTo: machineRawStockMovements.attributedTo,
        occurredAt: machineRawStockMovements.occurredAt,
        receivedAt: machineRawStockMovements.receivedAt,
        status: machineRawStockMovements.status,
        reconciliationReason: machineRawStockMovements.reconciliationReason,
        platformReviewStatus: machineRawStockMovements.platformReviewStatus,
        saleSafetyBlockerState: machineRawStockMovements.saleSafetyBlockerState,
        saleSafetyBlockerSlotId:
          machineRawStockMovements.saleSafetyBlockerSlotId,
        payloadJson: machineRawStockMovements.payloadJson,
        normalizedJson: machineRawStockMovements.normalizedJson,
        inventoryId: inventories.id,
        productName: products.name,
        sku: productVariants.sku,
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
        slotStatus: machineSlots.status,
        linkedOrderId: orders.id,
        linkedOrderNo: orders.orderNo,
        linkedCommandId: vendingCommands.id,
        linkedCommandNo: vendingCommands.commandNo,
      })
      .from(machineRawStockMovements)
      .innerJoin(machines, eq(machines.id, machineRawStockMovements.machineId))
      .leftJoin(
        machineSlots,
        sql`${machineSlots.id} = coalesce(${machineRawStockMovements.saleSafetyBlockerSlotId}, ${machineRawStockMovements.slotId})`,
      )
      .leftJoin(
        inventories,
        and(
          eq(inventories.machineId, machineRawStockMovements.machineId),
          eq(
            inventories.slotId,
            sql`coalesce(${machineRawStockMovements.saleSafetyBlockerSlotId}, ${machineRawStockMovements.slotId})`,
          ),
        ),
      )
      .leftJoin(productVariants, eq(productVariants.id, inventories.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(
        orders,
        and(
          eq(orders.machineId, machineRawStockMovements.machineId),
          sql`${orders.orderNo} = ${machineRawStockMovements.payloadJson}->'orderContext'->>'orderNo'`,
        ),
      )
      .leftJoin(
        vendingCommands,
        and(
          eq(vendingCommands.orderId, orders.id),
          sql`${vendingCommands.commandNo} = ${machineRawStockMovements.payloadJson}->'orderContext'->>'vendingCommandNo'`,
        ),
      );
  }

  private conflictCaseSelection(
    db: DrizzleClient | DrizzleTransaction = this.db,
  ) {
    return db
      .select({
        id: machineRawStockMovementConflicts.id,
        caseTable: sql<"machine_raw_stock_movement_conflicts">`'machine_raw_stock_movement_conflicts'`,
        rawMovementId: machineRawStockMovementConflicts.rawMovementId,
        machineId: machineRawStockMovementConflicts.machineId,
        machineCode: machines.code,
        movementId: machineRawStockMovementConflicts.movementId,
        planogramVersion: sql<string>`(${machineRawStockMovementConflicts.payloadJson}->>'planogramVersion')`,
        slotId: sql<string>`(${machineRawStockMovementConflicts.payloadJson}->>'slotId')::uuid`,
        movementType: sql<string>`(${machineRawStockMovementConflicts.payloadJson}->>'movementType')`,
        quantity: sql<number>`(${machineRawStockMovementConflicts.payloadJson}->>'quantity')::int`,
        beforeQuantity: sql<
          number | null
        >`(${machineRawStockMovementConflicts.payloadJson}->>'beforeQuantity')::int`,
        afterQuantity: sql<
          number | null
        >`(${machineRawStockMovementConflicts.payloadJson}->>'afterQuantity')::int`,
        source: sql<string>`(${machineRawStockMovementConflicts.payloadJson}->>'source')`,
        attributedTo: sql<
          string | null
        >`(${machineRawStockMovementConflicts.payloadJson}->>'attributedTo')`,
        occurredAt: sql<Date>`(${machineRawStockMovementConflicts.payloadJson}->>'occurredAt')::timestamptz`,
        receivedAt: machineRawStockMovementConflicts.receivedAt,
        status: machineRawStockMovementConflicts.status,
        reconciliationReason:
          machineRawStockMovementConflicts.reconciliationReason,
        platformReviewStatus:
          machineRawStockMovementConflicts.platformReviewStatus,
        saleSafetyBlockerState:
          machineRawStockMovementConflicts.saleSafetyBlockerState,
        saleSafetyBlockerSlotId:
          machineRawStockMovementConflicts.saleSafetyBlockerSlotId,
        payloadJson: machineRawStockMovementConflicts.payloadJson,
        normalizedJson: machineRawStockMovementConflicts.normalizedJson,
        inventoryId: inventories.id,
        productName: products.name,
        sku: productVariants.sku,
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
        slotStatus: machineSlots.status,
        linkedOrderId: orders.id,
        linkedOrderNo: orders.orderNo,
        linkedCommandId: vendingCommands.id,
        linkedCommandNo: vendingCommands.commandNo,
      })
      .from(machineRawStockMovementConflicts)
      .innerJoin(
        machines,
        eq(machines.id, machineRawStockMovementConflicts.machineId),
      )
      .leftJoin(
        machineSlots,
        sql`${machineSlots.id} = coalesce(${machineRawStockMovementConflicts.saleSafetyBlockerSlotId}, (${machineRawStockMovementConflicts.payloadJson}->>'slotId')::uuid)`,
      )
      .leftJoin(
        inventories,
        and(
          eq(inventories.machineId, machineRawStockMovementConflicts.machineId),
          eq(
            inventories.slotId,
            sql`coalesce(${machineRawStockMovementConflicts.saleSafetyBlockerSlotId}, (${machineRawStockMovementConflicts.payloadJson}->>'slotId')::uuid)`,
          ),
        ),
      )
      .leftJoin(productVariants, eq(productVariants.id, inventories.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(
        orders,
        and(
          eq(orders.machineId, machineRawStockMovementConflicts.machineId),
          sql`${orders.orderNo} = ${machineRawStockMovementConflicts.payloadJson}->'orderContext'->>'orderNo'`,
        ),
      )
      .leftJoin(
        vendingCommands,
        and(
          eq(vendingCommands.orderId, orders.id),
          sql`${vendingCommands.commandNo} = ${machineRawStockMovementConflicts.payloadJson}->'orderContext'->>'vendingCommandNo'`,
        ),
      );
  }
}

function rawStockReconciliationWhere(query: StockReconciliationPageQuery): SQL {
  const filters: SQL[] = [
    eq(machineRawStockMovements.status, "reconciliation"),
    eq(machineRawStockMovements.platformReviewStatus, "open"),
  ];
  if (query.machineId) {
    filters.push(eq(machineRawStockMovements.machineId, query.machineId));
  }
  return and(...filters)!;
}

function conflictStockReconciliationWhere(
  query: StockReconciliationPageQuery,
): SQL {
  const filters: SQL[] = [
    eq(machineRawStockMovementConflicts.status, "reconciliation"),
    eq(machineRawStockMovementConflicts.platformReviewStatus, "open"),
  ];
  if (query.machineId) {
    filters.push(
      eq(machineRawStockMovementConflicts.machineId, query.machineId),
    );
  }
  return and(...filters)!;
}

type SelectedCaseRow = StockReconciliationCaseRow;

function toCaseRow(row: SelectedCaseRow): StockReconciliationCaseRow {
  const rawPayload = row.payloadJson ?? {};
  const normalizedPayload = row.normalizedJson ?? {};
  const orderContext = Reflect.get(rawPayload, "orderContext");
  const fallbackOrderNo = objectStringProperty(orderContext, "orderNo");
  const fallbackCommandNo = objectStringProperty(
    orderContext,
    "vendingCommandNo",
  );
  return {
    ...row,
    payloadJson: rawPayload,
    normalizedJson: normalizedPayload,
    linkedOrderId: row.linkedOrderId,
    linkedOrderNo: row.linkedOrderNo ?? fallbackOrderNo,
    linkedCommandId: row.linkedCommandId,
    linkedCommandNo: row.linkedCommandNo ?? fallbackCommandNo,
  };
}

function objectStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property: unknown = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}
