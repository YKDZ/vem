import { z } from "zod";

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
