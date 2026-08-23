import { defineAdminContractManifest } from "../admin-contract-manifest";

export const operationsMaintenanceAdminContractManifest =
  defineAdminContractManifest({
    slice: "ops-maintenance",
    controllerPaths: [
      "apps/service-api/src/maintenance-work-orders/maintenance-work-orders.controller.ts",
      "apps/service-api/src/machine-ops/machine-ops.controller.ts",
      "apps/service-api/src/machines/machines.controller.ts",
      "apps/service-api/src/machines/qweather-config.controller.ts",
      "apps/service-api/src/inventory/inventory.controller.ts",
      "apps/service-api/src/inventory/stock-reconciliation.controller.ts",
    ],
    callerPaths: [
      "apps/admin-ui/src/api/work-orders.ts",
      "apps/admin-ui/src/api/machine-ops.ts",
    ],
    contracts: {
      adminListMaintenanceWorkOrdersContract: {
        method: "GET",
        path: "/maintenance-work-orders",
        providerMethod: "list",
        callerPath: "apps/admin-ui/src/api/work-orders.ts",
        callerMethods: ["listWorkOrders"],
      },
      adminResolveMaintenanceWorkOrderContract: {
        method: "POST",
        path: "/maintenance-work-orders/:id/resolve",
        providerMethod: "resolve",
        callerPath: "apps/admin-ui/src/api/work-orders.ts",
        callerMethods: ["resolveWorkOrder"],
      },
      adminListMachineOpsContract: {
        method: "GET",
        path: "/machine-ops",
        providerMethod: "listOps",
        callerPath: "apps/admin-ui/src/api/machine-ops.ts",
        callerMethods: ["listMachineOps"],
      },
      adminRequestMachineLogExportContract: {
        method: "POST",
        path: "/machine-ops/machines/:machineId/export-logs",
        providerMethod: "requestLogExport",
        callerPath: "apps/admin-ui/src/api/machine-ops.ts",
        callerMethods: ["requestLogExport"],
      },
    },
  });
