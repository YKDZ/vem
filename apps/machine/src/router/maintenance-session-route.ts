export type MaintenanceSessionRouteClient = {
  hasMaintenanceSessionForRoute(route: "maintenance" | "bring-up"): boolean;
  clearMaintenanceSession(): void;
};

type RouteIdentity = {
  name: unknown;
};

function isProtectedMaintenanceRoute(route: RouteIdentity): boolean {
  return route.name === "maintenance" || route.name === "bring-up";
}

/**
 * Browser-side maintenance sessions are route-scoped. Both directions of the
 * protected Maintenance/Bring-Up flow need an explicit handoff; all other
 * navigation drops the local bearer. The daemon still enforces its own
 * in-memory expiry and scope checks.
 */
export function reconcileMaintenanceSessionRoute(
  to: RouteIdentity,
  from: RouteIdentity,
  client: MaintenanceSessionRouteClient,
): void {
  if (to.name === "bring-up") {
    if (!client.hasMaintenanceSessionForRoute("bring-up")) {
      client.clearMaintenanceSession();
    }
    return;
  }

  if (to.name === "maintenance") {
    if (!client.hasMaintenanceSessionForRoute("maintenance")) {
      client.clearMaintenanceSession();
    }
    return;
  }

  if (isProtectedMaintenanceRoute(from)) {
    client.clearMaintenanceSession();
  }
}
