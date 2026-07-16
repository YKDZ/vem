import { createRouter, createWebHashHistory } from "vue-router";

import { daemonClient } from "@/daemon/client";

import { installMachineRouteAcceptanceHooks } from "./acceptance-hooks";
import { reconcileMaintenanceSessionRoute } from "./maintenance-session-route";
import { machineRoutes } from "./routes";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: machineRoutes,
});

router.beforeEach(async (to, from) => {
  return reconcileMaintenanceSessionRoute(to, from, daemonClient);
});

installMachineRouteAcceptanceHooks(router);
