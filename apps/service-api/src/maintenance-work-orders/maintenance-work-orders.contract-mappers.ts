import type {
  AdminMaintenanceWorkOrderResolveRequest,
  AdminMaintenanceWorkOrderResponse,
} from "@vem/shared";

import { maintenanceWorkOrders } from "@vem/db";
import {
  adminMaintenanceWorkOrderResponseSchema,
  maintenanceWorkOrderPrioritySchema,
  maintenanceWorkOrderStatusSchema,
} from "@vem/shared";

type MaintenanceWorkOrderUpdate = Partial<
  typeof maintenanceWorkOrders.$inferInsert
>;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function mapMaintenanceWorkOrderResolveDtoToPatch(
  adminUserId: string,
  input: AdminMaintenanceWorkOrderResolveRequest,
  resolvedAt = new Date(),
): MaintenanceWorkOrderUpdate {
  const dto = {
    resolutionNote: input.resolutionNote,
  } satisfies ContractFieldCoverage<AdminMaintenanceWorkOrderResolveRequest>;

  return {
    status: "resolved",
    assigneeAdminUserId: adminUserId,
    resolutionNote: dto.resolutionNote.trim(),
    resolvedAt,
    updatedAt: resolvedAt,
  } satisfies MaintenanceWorkOrderUpdate;
}

export function toAdminMaintenanceWorkOrderResponse(
  row: typeof maintenanceWorkOrders.$inferSelect,
): AdminMaintenanceWorkOrderResponse {
  const response = {
    id: row.id,
    workOrderNo: row.workOrderNo,
    machineId: row.machineId,
    slotId: row.slotId,
    orderId: row.orderId,
    commandId: row.commandId,
    title: row.title,
    description: row.description,
    priority: maintenanceWorkOrderPrioritySchema.parse(row.priority),
    status: maintenanceWorkOrderStatusSchema.parse(row.status),
    assigneeAdminUserId: row.assigneeAdminUserId,
    resolutionNote: row.resolutionNote,
    createdAt: toIsoString(row.createdAt),
    resolvedAt: row.resolvedAt ? toIsoString(row.resolvedAt) : null,
  } satisfies AdminMaintenanceWorkOrderResponse;
  return adminMaintenanceWorkOrderResponseSchema.parse(response);
}
