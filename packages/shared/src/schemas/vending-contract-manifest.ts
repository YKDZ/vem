import { defineAdminContractManifest } from "../admin-contract-manifest";

export const vendingAdminContractManifest = defineAdminContractManifest({
  slice: "vending",
  controllerPaths: ["apps/service-api/src/vending/vending.controller.ts"],
  callerPaths: [],
  contracts: {
    adminListVendingCommandsContract: {
      method: "GET",
      path: "/vending-commands",
      providerMethod: "listCommands",
    },
    adminResolveVendingCommandContract: {
      method: "POST",
      path: "/vending-commands/:id/resolve",
      providerMethod: "resolve",
    },
  },
});
