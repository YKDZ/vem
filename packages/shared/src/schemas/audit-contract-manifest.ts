import { defineAdminContractManifest } from "../admin-contract-manifest";

export const auditAdminContractManifest = defineAdminContractManifest({
  slice: "audit",
  controllerPaths: ["apps/service-api/src/audit/audit.controller.ts"],
  callerPaths: ["apps/admin-ui/src/api/audit.ts"],
  contracts: {
    adminListAuditLogsContract: {
      method: "GET",
      path: "/audit-logs",
      providerMethod: "list",
      callerPath: "apps/admin-ui/src/api/audit.ts",
      callerMethods: ["listAuditLogs"],
    },
  },
});
