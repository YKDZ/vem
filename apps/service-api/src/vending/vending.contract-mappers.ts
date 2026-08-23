import type {
  VendingCommandItemResponse,
  VendingCommandPageResponse,
} from "@vem/shared";

type VendingCommandListRow = {
  id: string;
  commandNo: string;
  orderId: string;
  machineId: string;
  machineCode: string;
  slotId: string;
  orderItemId: string | null;
  status: VendingCommandItemResponse["status"];
  retryCount: number;
  sentAt: Date | null;
  ackAt: Date | null;
  resultAt: Date | null;
  lastError: string | null;
  createdAt: Date;
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toVendingCommandItemResponse(
  row: VendingCommandListRow,
): VendingCommandItemResponse {
  return {
    id: row.id,
    commandNo: row.commandNo,
    orderId: row.orderId,
    machineId: row.machineId,
    machineCode: row.machineCode,
    slotId: row.slotId,
    orderItemId: row.orderItemId,
    status: row.status,
    retryCount: row.retryCount,
    sentAt: row.sentAt ? toIsoString(row.sentAt) : null,
    ackAt: row.ackAt ? toIsoString(row.ackAt) : null,
    resultAt: row.resultAt ? toIsoString(row.resultAt) : null,
    lastError: row.lastError,
    createdAt: toIsoString(row.createdAt),
  };
}

export function toVendingCommandPageResponse(input: {
  items: VendingCommandListRow[];
  page: number;
  pageSize: number;
  total: number;
}): VendingCommandPageResponse {
  return {
    items: input.items.map(toVendingCommandItemResponse),
    page: input.page,
    pageSize: input.pageSize,
    total: input.total,
  };
}
