import { z } from "zod";

import { defineAdminEndpointContract } from "../admin-api-contract";

const noPathParamsSchema = z.strictObject({});
const noBodySchema = z.strictObject({});

export const dashboardDateRangeQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const dashboardSummarySchema = z.object({
  todaySalesCents: z.int().min(0),
  todayOrderCount: z.int().min(0),
  lowStockCount: z.int().min(0),
  onlineMachineCount: z.int().min(0),
  pendingIssueCount: z.int().min(0),
});

export const dashboardTrendPointSchema = z.object({
  date: z.string(),
  salesCents: z.int().min(0),
  orderCount: z.int().min(0),
});

export const dashboardTopProductSchema = z.object({
  variantId: z.uuid(),
  productName: z.string(),
  sku: z.string(),
  quantity: z.int().min(0),
  salesCents: z.int().min(0),
});

export const dashboardCustomerProfileSchema = z.object({
  label: z.string(),
  count: z.int().min(0),
});

export const dashboardSalesTrendResponseSchema = z.array(
  dashboardTrendPointSchema,
);

export const dashboardTopProductsResponseSchema = z.array(
  dashboardTopProductSchema,
);

export const dashboardCustomerProfileResponseSchema = z.array(
  dashboardCustomerProfileSchema,
);

export const adminGetDashboardSummaryContract = defineAdminEndpointContract({
  method: "GET",
  path: "/dashboard/summary",
  pathParamsSchema: noPathParamsSchema,
  querySchema: dashboardDateRangeQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: dashboardSummarySchema,
});

export const adminGetDashboardSalesTrendContract = defineAdminEndpointContract({
  method: "GET",
  path: "/dashboard/sales-trend",
  pathParamsSchema: noPathParamsSchema,
  querySchema: dashboardDateRangeQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: dashboardSalesTrendResponseSchema,
});

export const adminGetDashboardTopProductsContract = defineAdminEndpointContract(
  {
    method: "GET",
    path: "/dashboard/top-products",
    pathParamsSchema: noPathParamsSchema,
    querySchema: dashboardDateRangeQuerySchema,
    bodySchema: noBodySchema,
    responseSchema: dashboardTopProductsResponseSchema,
  },
);

export const adminGetDashboardCustomerProfileContract =
  defineAdminEndpointContract({
    method: "GET",
    path: "/dashboard/customer-profile",
    pathParamsSchema: noPathParamsSchema,
    querySchema: dashboardDateRangeQuerySchema,
    bodySchema: noBodySchema,
    responseSchema: dashboardCustomerProfileResponseSchema,
  });

export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
export type DashboardTrendPoint = z.infer<typeof dashboardTrendPointSchema>;
export type DashboardTopProduct = z.infer<typeof dashboardTopProductSchema>;
export type DashboardCustomerProfile = z.infer<
  typeof dashboardCustomerProfileSchema
>;
