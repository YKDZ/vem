import { get, post } from "./request";

export type Inventory = {
  id: string;
  machineId: string;
  machineCode?: string;
  slotId: string;
  variantId: string;
  onHandQty: number;
  reservedQty: number;
  availableQty?: number;
  lowStockThreshold: number;
  machineName?: string;
  slotCode?: string;
  sku?: string;
  productName?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InventoryMovement = {
  id: string;
  inventoryId: string;
  deltaQty: number;
  reason: string;
  orderId: string | null;
  operatorAdminUserId: string | null;
  note: string | null;
  createdAt: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listInventories(
  query?: Record<string, unknown>,
): Promise<PageResult<Inventory>> {
  return await get<PageResult<Inventory>>("/inventories", { params: query });
}

export async function createInventory(body: {
  machineId: string;
  slotId: string;
  variantId: string;
  onHandQty: number;
  reservedQty?: number;
  lowStockThreshold?: number;
  note?: string;
}): Promise<Inventory> {
  return await post<Inventory>("/inventories", body);
}

export async function refillInventory(body: {
  inventoryId: string;
  quantity: number;
  note?: string;
}): Promise<Inventory> {
  return await post<Inventory>("/inventories/refill", body);
}

export async function adjustInventory(body: {
  inventoryId: string;
  deltaQty: number;
  note?: string;
}): Promise<Inventory> {
  return await post<Inventory>("/inventories/adjust", body);
}

export async function listInventoryMovements(
  query?: Record<string, unknown>,
): Promise<PageResult<InventoryMovement>> {
  return await get<PageResult<InventoryMovement>>("/inventory-movements", {
    params: query,
  });
}
