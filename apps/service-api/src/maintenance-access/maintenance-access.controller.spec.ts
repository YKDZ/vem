import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { MaintenanceAccessController } from "./maintenance-access.controller";

describe("MaintenanceAccessController", () => {
  it("requires dedicated read/write permissions and forwards the authenticated actor", async () => {
    const getOverview = vi.fn().mockResolvedValue({ sessions: [] });
    const createSession = vi.fn().mockResolvedValue({ id: "session-1" });
    const controller = new MaintenanceAccessController({
      getOverview,
      createSession,
    } as never);

    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        MaintenanceAccessController.prototype.getOverview,
      ),
    ).toEqual(["maintenanceAccess.read"]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        MaintenanceAccessController.prototype.createSession,
      ),
    ).toEqual(["maintenanceAccess.write"]);

    await expect(controller.getOverview()).resolves.toEqual({ sessions: [] });
    await expect(
      controller.createSession({ id: "admin-1" } as never, {
        sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
        targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 30,
        protocol: "tcp",
        port: 22,
      }),
    ).resolves.toEqual({ id: "session-1" });
    expect(createSession).toHaveBeenCalledWith("admin-1", {
      sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
      targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
      reason: "Investigate Windows runtime failure",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });
  });
});
