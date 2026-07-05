import type { z } from "zod";

import {
  adminInventoryContractNoBodySchema,
  adminInventoryListQuerySchema,
  adminInventoryMovementListQuerySchema,
  adminInventoryMovementPageResponseSchema,
  adminInventoryPageResponseSchema,
  adminInventoryResponseSchema,
  adminStockReconciliationCaseDetailResponseSchema,
  adminStockReconciliationCasePageResponseSchema,
  adminStockReconciliationListQuerySchema,
  adminStockReconciliationResolveRequestSchema,
  adjustInventorySchema,
  createInventorySchema,
  refillInventorySchema,
  type AdminInventoryMovementResponse,
  type AdminInventoryResponse,
  type AdminStockReconciliationCaseDetailResponse,
  type AdminStockReconciliationCaseSummaryResponse,
} from "@vem/shared";

import { getContract, postContract } from "./request";

export type Inventory = AdminInventoryResponse & {
  machineName?: string;
};

export type InventoryMovement = AdminInventoryMovementResponse;

export type StockReconciliationCaseSummary =
  AdminStockReconciliationCaseSummaryResponse;

export type StockReconciliationCaseDetail =
  AdminStockReconciliationCaseDetailResponse;

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listInventories(
  query?: z.input<typeof adminInventoryListQuerySchema>,
): Promise<PageResult<Inventory>> {
  return await getContract(
    "/inventories",
    adminInventoryListQuerySchema,
    adminInventoryPageResponseSchema,
    query ?? {},
  );
}

export async function createInventory(
  body: z.input<typeof createInventorySchema>,
): Promise<Inventory> {
  return await postContract(
    "/inventories",
    createInventorySchema,
    adminInventoryResponseSchema,
    body,
  );
}

export async function refillInventory(
  body: z.input<typeof refillInventorySchema>,
): Promise<Inventory> {
  return await postContract(
    "/inventories/refill",
    refillInventorySchema,
    adminInventoryResponseSchema,
    body,
  );
}

export async function adjustInventory(
  body: z.input<typeof adjustInventorySchema>,
): Promise<Inventory> {
  return await postContract(
    "/inventories/adjust",
    adjustInventorySchema,
    adminInventoryResponseSchema,
    body,
  );
}

export async function listInventoryMovements(
  query?: z.input<typeof adminInventoryMovementListQuerySchema>,
): Promise<PageResult<InventoryMovement>> {
  return await getContract(
    "/inventory-movements",
    adminInventoryMovementListQuerySchema,
    adminInventoryMovementPageResponseSchema,
    query ?? {},
  );
}

export async function listStockReconciliationCases(
  query?: z.input<typeof adminStockReconciliationListQuerySchema>,
): Promise<PageResult<StockReconciliationCaseSummary>> {
  return await getContract(
    "/stock-reconciliation-cases",
    adminStockReconciliationListQuerySchema,
    adminStockReconciliationCasePageResponseSchema,
    query ?? {},
  );
}

export async function getStockReconciliationCase(
  id: string,
): Promise<StockReconciliationCaseDetail> {
  return await getContract(
    `/stock-reconciliation-cases/${id}`,
    adminInventoryContractNoBodySchema,
    adminStockReconciliationCaseDetailResponseSchema,
    {},
  );
}

export async function resolveStockReconciliationCase(
  id: string,
  body: z.input<typeof adminStockReconciliationResolveRequestSchema>,
): Promise<StockReconciliationCaseDetail> {
  return await postContract(
    `/stock-reconciliation-cases/${id}/resolve`,
    adminStockReconciliationResolveRequestSchema,
    adminStockReconciliationCaseDetailResponseSchema,
    body,
  );
}
