import { describe, expect, it, vi } from "vitest";

import { reconcileMaintenanceSessionRoute } from "./maintenance-session-route";

function sessionClient(
  handoffActive: boolean,
  route: "maintenance" | "bring-up" = "bring-up",
) {
  return {
    hasMaintenanceSessionForRoute: vi
      .fn()
      .mockImplementation(
        (requestedRoute: "maintenance" | "bring-up") =>
          handoffActive && requestedRoute === route,
      ),
    clearMaintenanceSession: vi.fn(),
    revokeMaintenanceSessionRoute: vi.fn().mockResolvedValue(undefined),
  };
}

describe("maintenance session route scope", () => {
  it("preserves only an explicit Maintenance-to-Bring-Up handoff", async () => {
    const client = sessionClient(true);

    await reconcileMaintenanceSessionRoute(
      { name: "bring-up" },
      { name: "maintenance" },
      client,
    );

    expect(client.hasMaintenanceSessionForRoute).toHaveBeenCalledWith(
      "bring-up",
    );
    expect(client.clearMaintenanceSession).not.toHaveBeenCalled();
  });

  it("clears a session when Bring-Up is opened without a handoff", async () => {
    const client = sessionClient(false);

    await reconcileMaintenanceSessionRoute(
      { name: "bring-up" },
      { name: "boot" },
      client,
    );

    expect(client.clearMaintenanceSession).toHaveBeenCalledOnce();
  });

  it("revokes a handed-off session before the protected flow is left", async () => {
    const client = sessionClient(true);

    await reconcileMaintenanceSessionRoute(
      { name: "catalog" },
      { name: "bring-up" },
      client,
    );

    expect(client.revokeMaintenanceSessionRoute).toHaveBeenCalledWith(
      "bring-up",
    );
    expect(client.clearMaintenanceSession).not.toHaveBeenCalled();
  });

  it("preserves an explicit Bring-Up-to-Maintenance continuation", async () => {
    const client = sessionClient(true, "maintenance");

    await reconcileMaintenanceSessionRoute(
      { name: "maintenance" },
      { name: "bring-up" },
      client,
    );

    expect(client.hasMaintenanceSessionForRoute).toHaveBeenCalledWith(
      "maintenance",
    );
    expect(client.clearMaintenanceSession).not.toHaveBeenCalled();
  });

  it("still clears the local bearer when daemon revocation fails", async () => {
    const client = sessionClient(true);
    client.revokeMaintenanceSessionRoute.mockRejectedValueOnce(
      new Error("daemon unavailable"),
    );

    await reconcileMaintenanceSessionRoute(
      { name: "catalog" },
      { name: "bring-up" },
      client,
    );

    expect(client.revokeMaintenanceSessionRoute).toHaveBeenCalledWith(
      "bring-up",
    );
    expect(client.clearMaintenanceSession).toHaveBeenCalledOnce();
  });
});
