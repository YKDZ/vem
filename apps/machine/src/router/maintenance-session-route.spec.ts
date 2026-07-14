import { describe, expect, it, vi } from "vitest";

import { reconcileMaintenanceSessionRoute } from "./maintenance-session-route";

function sessionClient(handoffActive: boolean) {
  return {
    hasMaintenanceSessionForRoute: vi.fn().mockReturnValue(handoffActive),
    clearMaintenanceSession: vi.fn(),
  };
}

describe("maintenance session route scope", () => {
  it("preserves only an explicit Maintenance-to-Bring-Up handoff", () => {
    const client = sessionClient(true);

    reconcileMaintenanceSessionRoute(
      { name: "bring-up" },
      { name: "maintenance" },
      client,
    );

    expect(client.hasMaintenanceSessionForRoute).toHaveBeenCalledWith(
      "bring-up",
    );
    expect(client.clearMaintenanceSession).not.toHaveBeenCalled();
  });

  it("clears a session when Bring-Up is opened without a handoff", () => {
    const client = sessionClient(false);

    reconcileMaintenanceSessionRoute(
      { name: "bring-up" },
      { name: "boot" },
      client,
    );

    expect(client.clearMaintenanceSession).toHaveBeenCalledOnce();
  });

  it("clears a handed-off session when the protected flow is left", () => {
    const client = sessionClient(true);

    reconcileMaintenanceSessionRoute(
      { name: "catalog" },
      { name: "bring-up" },
      client,
    );

    expect(client.clearMaintenanceSession).toHaveBeenCalledOnce();
  });
});
