import { get, post } from "./request";

export type WorkOrder = {
  id: string;
  workOrderNo: string;
  machineId: string | null;
  slotId: string | null;
  orderId: string | null;
  commandId: string | null;
  title: string;
  description: string;
  priority: string;
  status: string;
  assigneeAdminUserId: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listWorkOrders(
  query?: Record<string, unknown>,
): Promise<PageResult<WorkOrder>> {
  return await get<PageResult<WorkOrder>>("/maintenance-work-orders", {
    params: query,
  });
}

export async function resolveWorkOrder(
  id: string,
  resolutionNote: string,
): Promise<WorkOrder> {
  return await post<WorkOrder>(`/maintenance-work-orders/${id}/resolve`, {
    resolutionNote,
  });
}
