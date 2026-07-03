import { createRouter, createWebHashHistory } from "vue-router";

import { machineRoutes } from "./routes";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: machineRoutes,
});
