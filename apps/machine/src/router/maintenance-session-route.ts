export type MaintenanceSessionRouteClient = {
  hasMaintenanceSessionForRoute(route: "bring-up"): boolean;
  clearMaintenanceSession(): void;
};

type RouteIdentity = {
  name: unknown;
};

function isProtectedMaintenanceRoute(route: RouteIdentity): boolean {
  return route.name === "maintenance" || route.name === "bring-up";
}

/**
 * Browser-side maintenance sessions are route-scoped. The only allowed
 * transition is the explicit handoff issued by Maintenance before Bring-Up.
 * Any other navigation drops the local bearer; the daemon still enforces its
 * own in-memory expiry and scope checks.
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

  if (isProtectedMaintenanceRoute(from)) {
    client.clearMaintenanceSession();
  }
}
