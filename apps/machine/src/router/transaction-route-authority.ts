import type { Pinia } from "pinia";
import type { RouteLocationRaw, Router } from "vue-router";

import { useCheckoutStore } from "@/stores/checkout";

export function installTransactionRouteAuthority(
  router: Router,
  pinia: Pinia,
): () => void {
  const checkoutStore = useCheckoutStore(pinia);
  return router.beforeEach((to) => {
    const view = checkoutStore.customerCheckoutView;
    if (view.stage === "none") return;

    const target = view.routeTarget as RouteLocationRaw;
    if (router.resolve(target).path === to.path) return;
    return target;
  });
}
