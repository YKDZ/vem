import type { z } from "zod";

import {
  dashboardCustomerProfileResponseSchema,
  dashboardDateRangeQuerySchema,
  dashboardSalesTrendResponseSchema,
  dashboardSummarySchema,
  dashboardTopProductsResponseSchema,
  type DashboardCustomerProfile,
  type DashboardSummary,
  type DashboardTopProduct,
  type DashboardTrendPoint,
} from "@vem/shared";

import { getContract } from "./request";

export type {
  DashboardCustomerProfile,
  DashboardSummary,
  DashboardTopProduct,
  DashboardTrendPoint,
} from "@vem/shared";

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return await getContract(
    "/dashboard/summary",
    dashboardDateRangeQuerySchema,
    dashboardSummarySchema,
    {},
  );
}

export async function getSalesTrend(
  query?: z.input<typeof dashboardDateRangeQuerySchema>,
): Promise<DashboardTrendPoint[]> {
  return await getContract(
    "/dashboard/sales-trend",
    dashboardDateRangeQuerySchema,
    dashboardSalesTrendResponseSchema,
    query ?? {},
  );
}

export async function getTopProducts(
  query?: z.input<typeof dashboardDateRangeQuerySchema>,
): Promise<DashboardTopProduct[]> {
  return await getContract(
    "/dashboard/top-products",
    dashboardDateRangeQuerySchema,
    dashboardTopProductsResponseSchema,
    query ?? {},
  );
}

export async function getCustomerProfile(
  query?: z.input<typeof dashboardDateRangeQuerySchema>,
): Promise<DashboardCustomerProfile[]> {
  return await getContract(
    "/dashboard/customer-profile",
    dashboardDateRangeQuerySchema,
    dashboardCustomerProfileResponseSchema,
    query ?? {},
  );
}
