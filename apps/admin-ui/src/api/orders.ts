import type { z } from "zod";

import {
  adminCreateOrderRecoveryActionContract,
  adminGetOrderInvestigationContract,
  adminListOrdersContract,
  adminRequestOrderRefundContract,
  type AdminOrderListItemResponse,
  type OrderInvestigationResponse,
  type OrderRefundRequestResponse,
  type OrderRecoveryActionResponse,
  type PageResult,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type Order = AdminOrderListItemResponse;

export type OrderInvestigation = OrderInvestigationResponse;

export type OrderRecoveryAction = z.output<
  typeof adminCreateOrderRecoveryActionContract.bodySchema
>["action"];
export type { PageResult };

export async function listOrders(
  query?: z.input<typeof adminListOrdersContract.querySchema>,
): Promise<PageResult<Order>> {
  return await callAdminEndpointContract(adminListOrdersContract, {
    query: query ?? {},
  });
}

export async function getOrderInvestigation(
  id: string,
): Promise<OrderInvestigation> {
  return await callAdminEndpointContract(adminGetOrderInvestigationContract, {
    pathParams: { id },
  });
}

export async function requestRefund(
  id: string,
): Promise<OrderRefundRequestResponse> {
  return await callAdminEndpointContract(adminRequestOrderRefundContract, {
    pathParams: { id },
  });
}

export async function createOrderRecoveryAction(
  id: string,
  input: z.input<typeof adminCreateOrderRecoveryActionContract.bodySchema>,
): Promise<OrderRecoveryActionResponse> {
  return await callAdminEndpointContract(
    adminCreateOrderRecoveryActionContract,
    {
      pathParams: { id },
      body: input,
    },
  );
}
