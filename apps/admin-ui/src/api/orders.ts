import type { OrderStatus } from "@vem/shared";

import { get, post } from "./request";

export type Order = {
  id: string;
  orderNo: string;
  machineId: string;
  machineCode?: string;
  status: OrderStatus;
  totalAmountCents: number;
  paidAt: string | null;
  dispensedAt: string | null;
  createdAt: string;
};

export type OrderDetail = {
  order: Order & {
    currency: string;
    canceledAt: string | null;
  };
  items: Array<{
    id: string;
    variantId: string;
    quantity: number;
    unitPriceCents: number;
    productSnapshot: Record<string, unknown>;
  }>;
  payments: Array<{
    id: string;
    paymentNo: string;
    status: string;
    amountCents: number;
    paidAt: string | null;
    failedReason: string | null;
  }>;
  paymentEvents: Array<Record<string, unknown>>;
  vendingCommands: Array<Record<string, unknown>>;
  inventoryMovements: Array<Record<string, unknown>>;
  orderStatusEvents: Array<{
    id: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    reason: string;
    createdAt: string;
  }>;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listOrders(
  query?: Record<string, unknown>,
): Promise<PageResult<Order>> {
  return await get<PageResult<Order>>("/orders", { params: query });
}

export async function getOrderDetail(id: string): Promise<OrderDetail> {
  return await get<OrderDetail>(`/orders/${id}`);
}

export async function requestRefund(id: string): Promise<void> {
  await post<void>(`/orders/${id}/refund`);
}
