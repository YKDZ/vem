import { defineAdminContractManifest } from "../admin-contract-manifest";

export const ordersAdminContractManifest = defineAdminContractManifest({
  slice: "orders",
  controllerPaths: ["apps/service-api/src/orders/orders.controller.ts"],
  callerPaths: ["apps/admin-ui/src/api/orders.ts"],
  contracts: {
    adminListOrdersContract: {
      method: "GET",
      path: "/orders",
      providerMethod: "listOrders",
      callerPath: "apps/admin-ui/src/api/orders.ts",
      callerMethods: ["listOrders"],
    },
    adminGetOrderInvestigationContract: {
      method: "GET",
      path: "/orders/:id/investigation",
      providerMethod: "getOrderInvestigation",
      callerPath: "apps/admin-ui/src/api/orders.ts",
      callerMethods: ["getOrderInvestigation"],
    },
    adminGetOrderDetailContract: {
      method: "GET",
      path: "/orders/:id",
      providerMethod: "getOrderDetail",
    },
    adminRequestOrderRefundContract: {
      method: "POST",
      path: "/orders/:id/refund",
      providerMethod: "requestRefund",
      callerPath: "apps/admin-ui/src/api/orders.ts",
      callerMethods: ["requestRefund"],
    },
    adminCreateOrderRecoveryActionContract: {
      method: "POST",
      path: "/orders/:id/recovery-actions",
      providerMethod: "createRecoveryAction",
      callerPath: "apps/admin-ui/src/api/orders.ts",
      callerMethods: ["createOrderRecoveryAction"],
    },
  },
});
