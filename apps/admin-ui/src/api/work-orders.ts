import type { z } from "zod";

import {
  adminListMaintenanceWorkOrdersContract,
  adminMaintenanceWorkOrderListQuerySchema,
  adminResolveMaintenanceWorkOrderContract,
  type AdminMaintenanceWorkOrderResponse,
  type PageResult,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type WorkOrder = AdminMaintenanceWorkOrderResponse;
export type { PageResult };

export async function listWorkOrders(
  query?: z.input<typeof adminMaintenanceWorkOrderListQuerySchema>,
): Promise<PageResult<WorkOrder>> {
  return await callAdminEndpointContract(
    adminListMaintenanceWorkOrdersContract,
    { query: query ?? {} },
  );
}

export async function resolveWorkOrder(
  id: string,
  resolutionNote: string,
): Promise<WorkOrder> {
  return await callAdminEndpointContract(
    adminResolveMaintenanceWorkOrderContract,
    { pathParams: { id }, body: { resolutionNote } },
  );
}
