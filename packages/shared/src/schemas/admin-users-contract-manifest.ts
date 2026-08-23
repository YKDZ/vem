import { defineAdminContractManifest } from "../admin-contract-manifest";

export const adminUsersAdminContractManifest = defineAdminContractManifest({
  slice: "admin-users",
  controllerPaths: [
    "apps/service-api/src/admin-users/admin-users.controller.ts",
  ],
  callerPaths: ["apps/admin-ui/src/api/admin-users.ts"],
  contracts: {
    adminListAdminUsersContract: {
      method: "GET",
      path: "/admin-users",
      providerMethod: "list",
      callerPath: "apps/admin-ui/src/api/admin-users.ts",
      callerMethods: ["listAdminUsers"],
    },
    adminCreateAdminUserContract: {
      method: "POST",
      path: "/admin-users",
      providerMethod: "create",
      callerPath: "apps/admin-ui/src/api/admin-users.ts",
      callerMethods: ["createAdminUser"],
    },
    adminUpdateAdminUserContract: {
      method: "PATCH",
      path: "/admin-users/:id",
      providerMethod: "update",
      callerPath: "apps/admin-ui/src/api/admin-users.ts",
      callerMethods: ["updateAdminUser"],
    },
  },
});
