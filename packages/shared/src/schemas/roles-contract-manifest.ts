import { defineAdminContractManifest } from "../admin-contract-manifest";

export const rolesAdminContractManifest = defineAdminContractManifest({
  slice: "roles",
  controllerPaths: ["apps/service-api/src/roles/roles.controller.ts"],
  callerPaths: ["apps/admin-ui/src/api/roles.ts"],
  contracts: {
    adminListRolesContract: {
      method: "GET",
      path: "/roles",
      providerMethod: "list",
      callerPath: "apps/admin-ui/src/api/roles.ts",
      callerMethods: ["listRoles"],
    },
    adminCreateRoleContract: {
      method: "POST",
      path: "/roles",
      providerMethod: "create",
      callerPath: "apps/admin-ui/src/api/roles.ts",
      callerMethods: ["createRole"],
    },
    adminUpdateRoleContract: {
      method: "PATCH",
      path: "/roles/:id",
      providerMethod: "update",
      callerPath: "apps/admin-ui/src/api/roles.ts",
      callerMethods: ["updateRole"],
    },
    adminListPermissionCodesContract: {
      method: "GET",
      path: "/permissions",
      providerMethod: "getPermissions",
      callerPath: "apps/admin-ui/src/api/roles.ts",
      callerMethods: ["listPermissions"],
    },
  },
});
