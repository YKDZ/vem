import type { Router } from "vue-router";

import { useAuthStore } from "@/stores/auth";

export function setupRouterGuards(router: Router): void {
  router.beforeEach(async (to) => {
    const authStore = useAuthStore();

    if (to.name === "login") {
      if (authStore.isAuthenticated)
        return { path: "/dashboard", replace: true };
      return true;
    }

    if (to.meta.requiresAuth && !authStore.isAuthenticated) {
      return {
        path: "/login",
        query: { redirect: to.fullPath },
        replace: true,
      };
    }

    if (authStore.isAuthenticated && !authStore.currentAdmin) {
      try {
        await authStore.fetchMe();
      } catch {
        authStore.logout();
        return {
          path: "/login",
          query: { redirect: to.fullPath },
          replace: true,
        };
      }
    }

    const required = to.meta.requiredPermissions ?? [];
    if (required.length > 0 && !authStore.hasEveryPermission(required)) {
      return { path: "/403", replace: true };
    }

    return true;
  });

  router.afterEach((to) => {
    if (typeof to.meta.title === "string") {
      document.title = `${to.meta.title} - VEM 管理后台`;
    }
  });
}
