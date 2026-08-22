import type { z } from "zod";

import {
  adminAdjustInventoryContract,
  adminCreateInventoryContract,
  adminGetStockReconciliationCaseContract,
  adminInventoryListQuerySchema,
  adminListInventoryMovementsContract,
  adminListInventoriesContract,
  adminListStockReconciliationCasesContract,
  adminResolveStockReconciliationCaseContract,
  adminInventoryMovementListQuerySchema,
  adminStockReconciliationListQuerySchema,
  adminStockReconciliationResolveRequestSchema,
  adjustInventorySchema,
  createInventorySchema,
  type AdminInventoryMovementResponse,
  type AdminInventoryResponse,
  type AdminStockReconciliationCaseDetailResponse,
  type AdminStockReconciliationCaseSummaryResponse,
  type PageResult,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type Inventory = AdminInventoryResponse & {
  machineName?: string;
};

export type InventoryMovement = AdminInventoryMovementResponse;

export type StockReconciliationCaseSummary =
  AdminStockReconciliationCaseSummaryResponse;

export type StockReconciliationCaseDetail =
  AdminStockReconciliationCaseDetailResponse;
export type { PageResult };

export async function listInventories(
  query?: z.input<typeof adminInventoryListQuerySchema>,
): Promise<PageResult<Inventory>> {
  return await callAdminEndpointContract(adminListInventoriesContract, {
    query: query ?? {},
  });
}

export async function createInventory(
  body: z.input<typeof createInventorySchema>,
): Promise<Inventory> {
  return await callAdminEndpointContract(adminCreateInventoryContract, {
    body,
  });
}

export async function adjustInventory(
  body: z.input<typeof adjustInventorySchema>,
): Promise<Inventory> {
  return await callAdminEndpointContract(adminAdjustInventoryContract, {
    body,
  });
}

export async function listInventoryMovements(
  query?: z.input<typeof adminInventoryMovementListQuerySchema>,
): Promise<PageResult<InventoryMovement>> {
  return await callAdminEndpointContract(adminListInventoryMovementsContract, {
    query: query ?? {},
  });
}

export async function listStockReconciliationCases(
  query?: z.input<typeof adminStockReconciliationListQuerySchema>,
): Promise<PageResult<StockReconciliationCaseSummary>> {
  return await callAdminEndpointContract(
    adminListStockReconciliationCasesContract,
    { query: query ?? {} },
  );
}

export async function getStockReconciliationCase(
  id: string,
): Promise<StockReconciliationCaseDetail> {
  return await callAdminEndpointContract(
    adminGetStockReconciliationCaseContract,
    { pathParams: { id } },
  );
}

export async function resolveStockReconciliationCase(
  id: string,
  body: z.input<typeof adminStockReconciliationResolveRequestSchema>,
): Promise<StockReconciliationCaseDetail> {
  return await callAdminEndpointContract(
    adminResolveStockReconciliationCaseContract,
    { pathParams: { id }, body },
  );
}
