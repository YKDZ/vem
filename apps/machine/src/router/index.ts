import { createRouter, createWebHashHistory } from "vue-router";

import { installMachineRouteAcceptanceHooks } from "./acceptance-hooks";
import { machineRoutes } from "./routes";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: machineRoutes,
});

installMachineRouteAcceptanceHooks(router);
