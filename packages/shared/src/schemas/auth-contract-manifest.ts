import { defineAdminContractManifest } from "../admin-contract-manifest";

export const authAdminContractManifest = defineAdminContractManifest({
  slice: "auth",
  controllerPaths: ["apps/service-api/src/auth/auth.controller.ts"],
  callerPaths: ["apps/admin-ui/src/api/current-admin.ts"],
  contracts: {
    adminGetCurrentAdminContract: {
      method: "GET",
      path: "/auth/me",
      providerMethod: "me",
      callerPath: "apps/admin-ui/src/api/current-admin.ts",
      callerMethods: ["meApi"],
    },
  },
});
