import { defineAdminContractManifest } from "../admin-contract-manifest";

export const hardwareErrorPoliciesAdminContractManifest =
  defineAdminContractManifest({
    slice: "hardware-error-policies",
    controllerPaths: [
      "apps/service-api/src/hardware-error-policies/hardware-error-policies.controller.ts",
    ],
    callerPaths: ["apps/admin-ui/src/api/hardware-error-policies.ts"],
    contracts: {
      adminListHardwareErrorPoliciesContract: {
        method: "GET",
        path: "/hardware-error-policies",
        providerMethod: "listPolicies",
        callerPath: "apps/admin-ui/src/api/hardware-error-policies.ts",
        callerMethods: ["listHardwareErrorPolicies"],
      },
      adminUpsertHardwareErrorPolicyContract: {
        method: "POST",
        path: "/hardware-error-policies",
        providerMethod: "upsertPolicy",
        callerPath: "apps/admin-ui/src/api/hardware-error-policies.ts",
        callerMethods: ["upsertHardwareErrorPolicy"],
      },
    },
  });
