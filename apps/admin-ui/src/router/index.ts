import { createRouter, createWebHistory } from "vue-router";

import { setupRouterGuards } from "./guards";
import { routes } from "./routes";

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

setupRouterGuards(router);
