import { get } from "./request";

export type DashboardSummary = {
  todaySalesCents: number;
  todayOrderCount: number;
  lowStockCount: number;
  onlineMachineCount: number;
  pendingIssueCount: number;
};

export type DashboardTrendPoint = {
  date: string;
  salesCents: number;
  orderCount: number;
};

export type DashboardTopProduct = {
  variantId: string;
  productName: string;
  sku: string;
  quantity: number;
  salesCents: number;
};

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return await get<DashboardSummary>("/dashboard/summary");
}

export async function getSalesTrend(): Promise<DashboardTrendPoint[]> {
  return await get<DashboardTrendPoint[]>("/dashboard/sales-trend");
}

export async function getTopProducts(): Promise<DashboardTopProduct[]> {
  return await get<DashboardTopProduct[]>("/dashboard/top-products");
}
