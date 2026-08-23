import type { z } from "zod";

import {
  adminGetDashboardCustomerProfileContract,
  adminGetDashboardSalesTrendContract,
  adminGetDashboardSummaryContract,
  adminGetDashboardTopProductsContract,
  type DashboardCustomerProfile,
  type DashboardSummary,
  type DashboardTopProduct,
  type DashboardTrendPoint,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type {
  DashboardCustomerProfile,
  DashboardSummary,
  DashboardTopProduct,
  DashboardTrendPoint,
} from "@vem/shared";

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return await callAdminEndpointContract(adminGetDashboardSummaryContract, {});
}

export async function getSalesTrend(
  query?: z.input<typeof adminGetDashboardSalesTrendContract.querySchema>,
): Promise<DashboardTrendPoint[]> {
  return await callAdminEndpointContract(adminGetDashboardSalesTrendContract, {
    query: query ?? {},
  });
}

export async function getTopProducts(
  query?: z.input<typeof adminGetDashboardTopProductsContract.querySchema>,
): Promise<DashboardTopProduct[]> {
  return await callAdminEndpointContract(adminGetDashboardTopProductsContract, {
    query: query ?? {},
  });
}

export async function getCustomerProfile(
  query?: z.input<typeof adminGetDashboardCustomerProfileContract.querySchema>,
): Promise<DashboardCustomerProfile[]> {
  return await callAdminEndpointContract(
    adminGetDashboardCustomerProfileContract,
    { query: query ?? {} },
  );
}
