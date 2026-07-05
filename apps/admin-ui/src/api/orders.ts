import type { z } from "zod";

import {
  adminOrderContractNoBodySchema,
  adminOrderListQuerySchema,
  adminOrderPageResponseSchema,
  orderInvestigationResponseSchema,
  orderRefundRequestResponseSchema,
  orderRecoveryActionResponseSchema,
  orderRecoveryActionSchema,
  type AdminOrderListItemResponse,
  type OrderInvestigationResponse,
  type OrderRefundRequestResponse,
  type OrderRecoveryActionResponse,
  type OrderStatus,
} from "@vem/shared";

import { get, getContract, postContract } from "./request";

export type Order = AdminOrderListItemResponse;

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

export type OrderInvestigation = OrderInvestigationResponse;

export type OrderRecoveryAction = z.output<
  typeof orderRecoveryActionSchema
>["action"];

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listOrders(
  query?: z.input<typeof adminOrderListQuerySchema>,
): Promise<PageResult<Order>> {
  return await getContract(
    "/orders",
    adminOrderListQuerySchema,
    adminOrderPageResponseSchema,
    query ?? {},
  );
}

export async function getOrderDetail(id: string): Promise<OrderDetail> {
  return await get<OrderDetail>(`/orders/${id}`);
}

export async function getOrderInvestigation(
  id: string,
): Promise<OrderInvestigation> {
  return await getContract(
    `/orders/${id}/investigation`,
    adminOrderContractNoBodySchema,
    orderInvestigationResponseSchema,
    {},
  );
}

export async function requestRefund(
  id: string,
): Promise<OrderRefundRequestResponse> {
  return await postContract(
    `/orders/${id}/refund`,
    adminOrderContractNoBodySchema,
    orderRefundRequestResponseSchema,
    {},
  );
}

export async function createOrderRecoveryAction(
  id: string,
  input: z.input<typeof orderRecoveryActionSchema>,
): Promise<OrderRecoveryActionResponse> {
  return await postContract(
    `/orders/${id}/recovery-actions`,
    orderRecoveryActionSchema,
    orderRecoveryActionResponseSchema,
    input,
  );
}
