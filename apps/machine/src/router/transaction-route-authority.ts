import type { Pinia } from "pinia";
import { watch } from "vue";
import type { RouteLocationRaw, Router } from "vue-router";

import { useCheckoutStore } from "@/stores/checkout";

export function installTransactionRouteAuthority(
  router: Router,
  pinia: Pinia,
): () => void {
  const checkoutStore = useCheckoutStore(pinia);
  const removeGuard = router.beforeEach((to) => {
    const view = checkoutStore.customerCheckoutView;
    if (view.stage === "none") return;

    const target = view.routeTarget as RouteLocationRaw;
    if (router.resolve(target).path === to.path) return;
    return target;
  });
  const stopRouteSync = watch(
    () => checkoutStore.customerCheckoutView,
    (view) => {
      if (view.stage === "none") return;
      const target = view.routeTarget;
      if (router.currentRoute.value.matched.length === 0) return;
      if (router.resolve(target).path === router.currentRoute.value.path) return;
      void router.replace(target);
    },
    { deep: true },
  );
  return () => {
    stopRouteSync();
    removeGuard();
  };
}
