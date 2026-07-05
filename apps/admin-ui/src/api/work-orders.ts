import type { z } from "zod";

import {
  adminMaintenanceWorkOrderListQuerySchema,
  adminMaintenanceWorkOrderPageResponseSchema,
  adminMaintenanceWorkOrderResolveRequestSchema,
  adminMaintenanceWorkOrderResponseSchema,
  type AdminMaintenanceWorkOrderResponse,
  type PageResult,
} from "@vem/shared";

import { getContract, postContract } from "./request";

export type WorkOrder = AdminMaintenanceWorkOrderResponse;
export type { PageResult };

export async function listWorkOrders(
  query?: z.input<typeof adminMaintenanceWorkOrderListQuerySchema>,
): Promise<PageResult<WorkOrder>> {
  return await getContract(
    "/maintenance-work-orders",
    adminMaintenanceWorkOrderListQuerySchema,
    adminMaintenanceWorkOrderPageResponseSchema,
    query ?? {},
  );
}

export async function resolveWorkOrder(
  id: string,
  resolutionNote: string,
): Promise<WorkOrder> {
  return await postContract(
    `/maintenance-work-orders/${id}/resolve`,
    adminMaintenanceWorkOrderResolveRequestSchema,
    adminMaintenanceWorkOrderResponseSchema,
    { resolutionNote },
  );
}
