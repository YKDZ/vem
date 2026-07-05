import { inventories, inventoryMovements } from "@vem/db";
import {
  adminInventoryMovementResponseSchema,
  adminInventoryResponseSchema,
  type AdminAdjustInventoryRequest,
  type AdminCreateInventoryRequest,
  type AdminInventoryMovementResponse,
  type AdminInventoryResponse,
  type AdminRefillInventoryRequest,
} from "@vem/shared";

type InventoryInsert = typeof inventories.$inferInsert;
type InventoryMovementInsert = typeof inventoryMovements.$inferInsert;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;

type InventoryResponseRow = Pick<
  typeof inventories.$inferSelect,
  | "id"
  | "machineId"
  | "slotId"
  | "variantId"
  | "onHandQty"
  | "reservedQty"
  | "lowStockThreshold"
  | "createdAt"
  | "updatedAt"
> & {
  machineCode?: string;
  slotCode?: string;
  productId?: string;
  sku?: string;
  productName?: string;
  availableQty?: number;
};

type InventoryMovementResponseRow = Pick<
  typeof inventoryMovements.$inferSelect,
  | "id"
  | "inventoryId"
  | "deltaQty"
  | "reason"
  | "orderId"
  | "operatorAdminUserId"
  | "note"
  | "createdAt"
> & {
  orderNo?: string | null;
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function mapCreateInventoryDtoToInsert(
  input: AdminCreateInventoryRequest,
): InventoryInsert {
  const dto = {
    machineId: input.machineId,
    slotId: input.slotId,
    variantId: input.variantId,
    onHandQty: input.onHandQty,
    reservedQty: input.reservedQty,
    lowStockThreshold: input.lowStockThreshold,
    note: input.note,
  } satisfies ContractFieldCoverage<AdminCreateInventoryRequest>;

  const insert = {
    machineId: dto.machineId,
    slotId: dto.slotId,
    variantId: dto.variantId,
    onHandQty: dto.onHandQty,
    reservedQty: dto.reservedQty,
    lowStockThreshold: dto.lowStockThreshold,
  } satisfies InventoryInsert;
  return insert;
}

export function mapCreateInventoryDtoToMovementInsert(
  adminUserId: string,
  inventoryId: string,
  input: AdminCreateInventoryRequest,
): InventoryMovementInsert {
  const dto = {
    machineId: input.machineId,
    slotId: input.slotId,
    variantId: input.variantId,
    onHandQty: input.onHandQty,
    reservedQty: input.reservedQty,
    lowStockThreshold: input.lowStockThreshold,
    note: input.note,
  } satisfies ContractFieldCoverage<AdminCreateInventoryRequest>;

  const insert = {
    inventoryId,
    deltaQty: dto.onHandQty,
    reason: "adjust",
    operatorAdminUserId: adminUserId,
    note: dto.note ?? "initial inventory binding",
  } satisfies InventoryMovementInsert;
  return insert;
}

export function mapRefillInventoryDtoToMovementInsert(
  adminUserId: string,
  input: AdminRefillInventoryRequest,
): InventoryMovementInsert {
  const dto = {
    inventoryId: input.inventoryId,
    quantity: input.quantity,
    note: input.note,
  } satisfies ContractFieldCoverage<AdminRefillInventoryRequest>;

  const insert = {
    inventoryId: dto.inventoryId,
    deltaQty: dto.quantity,
    reason: "refill",
    operatorAdminUserId: adminUserId,
    note: dto.note ?? null,
  } satisfies InventoryMovementInsert;
  return insert;
}

export function mapAdjustInventoryDtoToMovementInsert(
  adminUserId: string,
  input: AdminAdjustInventoryRequest,
): InventoryMovementInsert {
  const dto = {
    inventoryId: input.inventoryId,
    deltaQty: input.deltaQty,
    note: input.note,
  } satisfies ContractFieldCoverage<AdminAdjustInventoryRequest>;

  const insert = {
    inventoryId: dto.inventoryId,
    deltaQty: dto.deltaQty,
    reason: "adjust",
    operatorAdminUserId: adminUserId,
    note: dto.note ?? null,
  } satisfies InventoryMovementInsert;
  return insert;
}

export function toAdminInventoryResponse(
  row: InventoryResponseRow,
): AdminInventoryResponse {
  const response = {
    id: row.id,
    machineId: row.machineId,
    ...(row.machineCode === undefined ? {} : { machineCode: row.machineCode }),
    slotId: row.slotId,
    ...(row.slotCode === undefined ? {} : { slotCode: row.slotCode }),
    variantId: row.variantId,
    ...(row.productId === undefined ? {} : { productId: row.productId }),
    ...(row.sku === undefined ? {} : { sku: row.sku }),
    ...(row.productName === undefined ? {} : { productName: row.productName }),
    onHandQty: row.onHandQty,
    reservedQty: row.reservedQty,
    ...(row.availableQty === undefined
      ? {}
      : { availableQty: row.availableQty }),
    lowStockThreshold: row.lowStockThreshold,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  } satisfies AdminInventoryResponse;
  return adminInventoryResponseSchema.parse(response);
}

export function toAdminInventoryMovementResponse(
  row: InventoryMovementResponseRow,
): AdminInventoryMovementResponse {
  const response = {
    id: row.id,
    inventoryId: row.inventoryId,
    deltaQty: row.deltaQty,
    reason: row.reason,
    orderId: row.orderId,
    orderNo: row.orderNo ?? null,
    operatorAdminUserId: row.operatorAdminUserId,
    note: row.note,
    createdAt: toIsoString(row.createdAt),
  } satisfies AdminInventoryMovementResponse;
  return adminInventoryMovementResponseSchema.parse(response);
}
