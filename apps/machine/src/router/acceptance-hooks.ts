import type { RouteLocationNormalized, Router } from "vue-router";

export const MACHINE_ROUTE_CHANGED_EVENT = "route-changed";
export const MACHINE_ROUTE_NAME_ATTRIBUTE = "data-machine-route-name";
export const MACHINE_ROUTE_PATH_ATTRIBUTE = "data-machine-route-path";

type MachineRouteChangedDetail = {
  routeName: string;
  routePath: string;
  routeFullPath: string;
  fromRouteName: string;
  fromRoutePath: string;
  fromRouteFullPath: string;
};

function normalizedRouteName(route: RouteLocationNormalized): string {
  return typeof route.name === "string" ? route.name : "";
}

function machineRouteChangedDetail(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
): MachineRouteChangedDetail {
  return {
    routeName: normalizedRouteName(to),
    routePath: to.path,
    routeFullPath: to.fullPath,
    fromRouteName: normalizedRouteName(from),
    fromRoutePath: from.path,
    fromRouteFullPath: from.fullPath,
  };
}

function publishMachineRouteChanged(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const detail = machineRouteChangedDetail(to, from);
  document.body.setAttribute(MACHINE_ROUTE_NAME_ATTRIBUTE, detail.routeName);
  document.body.setAttribute(MACHINE_ROUTE_PATH_ATTRIBUTE, detail.routePath);
  window.dispatchEvent(
    new CustomEvent<MachineRouteChangedDetail>(MACHINE_ROUTE_CHANGED_EVENT, {
      detail,
    }),
  );
}

export function installMachineRouteAcceptanceHooks(router: Router): void {
  router.afterEach((to, from) => {
    publishMachineRouteChanged(to, from);
  });
}
