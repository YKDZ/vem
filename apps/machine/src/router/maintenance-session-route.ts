export type MaintenanceSessionRouteClient = {
  hasMaintenanceSessionForRoute(route: "maintenance" | "bring-up"): boolean;
  clearMaintenanceSession(): void;
  revokeMaintenanceSessionRoute(
    route: "maintenance" | "bring-up",
  ): Promise<void>;
};

type RouteIdentity = {
  name: unknown;
};

function isProtectedMaintenanceRoute(
  route: RouteIdentity,
): route is { name: "maintenance" | "bring-up" } {
  return route.name === "maintenance" || route.name === "bring-up";
}

/**
 * Browser-side maintenance sessions are route-scoped. Both directions of the
 * protected Maintenance/Bring-Up flow need an explicit handoff; all other
 * navigation drops the local bearer. The daemon still enforces its own
 * in-memory expiry and scope checks.
 */
export async function reconcileMaintenanceSessionRoute(
  to: RouteIdentity,
  from: RouteIdentity,
  client: MaintenanceSessionRouteClient,
): Promise<void> {
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
    try {
      await client.revokeMaintenanceSessionRoute(from.name);
    } catch {
      // Revocation is best effort for navigation availability; the daemon
      // still enforces expiry and the client method clears the local bearer
      // in its finally block.
      client.clearMaintenanceSession();
    }
  }
}
