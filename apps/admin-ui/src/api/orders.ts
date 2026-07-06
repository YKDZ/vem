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
  type PageResult,
} from "@vem/shared";

import { getContract, postContract } from "./request";

export type Order = AdminOrderListItemResponse;

export type OrderInvestigation = OrderInvestigationResponse;

export type OrderRecoveryAction = z.output<
  typeof orderRecoveryActionSchema
>["action"];
export type { PageResult };

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
