import { get, post } from "./request";

export type Inventory = {
  id: string;
  machineId: string;
  machineCode?: string;
  slotId: string;
  variantId: string;
  productId?: string;
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
  orderNo?: string | null;
  operatorAdminUserId: string | null;
  note: string | null;
  createdAt: string;
};

export type StockReconciliationCaseSummary = {
  id: string;
  caseTable: string;
  rawMovementId: string | null;
  machineId: string;
  machineCode: string;
  movementId: string;
  movementType: string;
  quantity: number;
  source: string;
  attributedTo: string | null;
  receivedAt: string;
  reconciliationReason: string | null;
  platformReviewStatus: string | null;
  slot: {
    id: string;
    code: string | null;
    status: string | null;
    saleEligibility: {
      eligible: boolean;
      slotSalesState: string;
      reason: string | null;
    };
  };
  inventory: {
    id: string;
    productName: string | null;
    sku: string | null;
    onHandQty: number;
    reservedQty: number;
    saleableQty: number;
  } | null;
  blocker: {
    state: string;
    reason: string | null;
    linkedCaseId: string;
    linkedOrderId: string | null;
    linkedOrderNo: string | null;
    linkedCommandId: string | null;
    linkedCommandNo: string | null;
  } | null;
};

export type StockReconciliationCaseDetail = StockReconciliationCaseSummary & {
  planogramVersion: string;
  evidence: {
    rawPayload: Record<string, unknown>;
    normalizedPayload: Record<string, unknown>;
    inventory: StockReconciliationCaseSummary["inventory"];
    linkedOrder: { id: string | null; orderNo: string | null } | null;
    linkedCommand: { id: string | null; commandNo: string | null } | null;
  };
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

export async function listStockReconciliationCases(
  query?: Record<string, unknown>,
): Promise<PageResult<StockReconciliationCaseSummary>> {
  return await get<PageResult<StockReconciliationCaseSummary>>(
    "/stock-reconciliation-cases",
    { params: query },
  );
}

export async function getStockReconciliationCase(
  id: string,
): Promise<StockReconciliationCaseDetail> {
  return await get<StockReconciliationCaseDetail>(
    `/stock-reconciliation-cases/${id}`,
  );
}

export async function resolveStockReconciliationCase(
  id: string,
  body: {
    action: "accept_machine_stock" | "reject_machine_stock" | "manual_correct";
    note: string;
    clearBlocker?: boolean;
    correctedOnHandQty?: number;
  },
): Promise<StockReconciliationCaseDetail> {
  return await post<StockReconciliationCaseDetail>(
    `/stock-reconciliation-cases/${id}/resolve`,
    body,
  );
}
