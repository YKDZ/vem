import { createRouter, createWebHashHistory } from "vue-router";

import { daemonClient } from "@/daemon/client";

import { reconcileMaintenanceSessionRoute } from "./maintenance-session-route";
import { machineRoutes } from "./routes";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: machineRoutes,
});

router.beforeEach((to, from) => {
  reconcileMaintenanceSessionRoute(to, from, daemonClient);
});
