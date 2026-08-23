import { defineAdminContractManifest } from "../admin-contract-manifest";

export const dashboardAdminContractManifest = defineAdminContractManifest({
  slice: "dashboard",
  controllerPaths: ["apps/service-api/src/dashboard/dashboard.controller.ts"],
  callerPaths: ["apps/admin-ui/src/api/dashboard.ts"],
  contracts: {
    adminGetDashboardSummaryContract: {
      method: "GET",
      path: "/dashboard/summary",
      providerMethod: "summary",
      callerPath: "apps/admin-ui/src/api/dashboard.ts",
      callerMethods: ["getDashboardSummary"],
    },
    adminGetDashboardSalesTrendContract: {
      method: "GET",
      path: "/dashboard/sales-trend",
      providerMethod: "salesTrend",
      callerPath: "apps/admin-ui/src/api/dashboard.ts",
      callerMethods: ["getSalesTrend"],
    },
    adminGetDashboardTopProductsContract: {
      method: "GET",
      path: "/dashboard/top-products",
      providerMethod: "topProducts",
      callerPath: "apps/admin-ui/src/api/dashboard.ts",
      callerMethods: ["getTopProducts"],
    },
    adminGetDashboardCustomerProfileContract: {
      method: "GET",
      path: "/dashboard/customer-profile",
      providerMethod: "customerProfile",
      callerPath: "apps/admin-ui/src/api/dashboard.ts",
      callerMethods: ["getCustomerProfile"],
    },
  },
});
