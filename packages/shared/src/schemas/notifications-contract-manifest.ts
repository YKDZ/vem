import { defineAdminContractManifest } from "../admin-contract-manifest";

export const notificationsAdminContractManifest = defineAdminContractManifest({
  slice: "notifications",
  controllerPaths: [
    "apps/service-api/src/notifications/notifications.controller.ts",
  ],
  callerPaths: ["apps/admin-ui/src/api/notifications.ts"],
  contracts: {
    adminListNotificationsContract: {
      method: "GET",
      path: "/notifications",
      providerMethod: "list",
      callerPath: "apps/admin-ui/src/api/notifications.ts",
      callerMethods: ["listNotifications"],
    },
    adminMarkNotificationReadContract: {
      method: "POST",
      path: "/notifications/:id/read",
      providerMethod: "markRead",
      callerPath: "apps/admin-ui/src/api/notifications.ts",
      callerMethods: ["markNotificationRead"],
    },
  },
});
