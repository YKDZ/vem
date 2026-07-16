import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { MaintenanceAccessController } from "./maintenance-access.controller";

describe("MaintenanceAccessController", () => {
  it("requires dedicated read/write permissions and forwards the authenticated actor", async () => {
    const getOverview = vi.fn().mockResolvedValue({ sessions: [] });
    const listSessions = vi.fn().mockResolvedValue([]);
    const listAudit = vi.fn().mockResolvedValue([]);
    const createHumanSession = vi.fn().mockResolvedValue({ id: "session-1" });
    const revokeSession = vi.fn().mockResolvedValue({ id: "session-1" });
    const issueSshCertificateForHumanSession = vi
      .fn()
      .mockResolvedValue({ serial: 1 });
    const controller = new MaintenanceAccessController({
      getOverview,
      listSessions,
      listAudit,
      createHumanSession,
      revokeSession,
      issueSshCertificateForHumanSession,
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
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        MaintenanceAccessController.prototype.listSessions,
      ),
    ).toEqual(["maintenanceAccess.read"]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        MaintenanceAccessController.prototype.listAudit,
      ),
    ).toEqual(["maintenanceAccess.read"]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        MaintenanceAccessController.prototype.revokeSession,
      ),
    ).toEqual(["maintenanceAccess.write"]);

    await expect(controller.getOverview()).resolves.toEqual({ sessions: [] });
    await expect(
      controller.listSessions({ status: "revoked" }),
    ).resolves.toEqual([]);
    await expect(
      controller.listAudit({
        sessionId: "550e8400-e29b-41d4-a716-446655440003",
        limit: 25,
      }),
    ).resolves.toEqual([]);
    expect(listAudit).toHaveBeenCalledWith({
      sessionId: "550e8400-e29b-41d4-a716-446655440003",
      limit: 25,
    });
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
    expect(createHumanSession).toHaveBeenCalledWith("admin-1", {
      sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
      targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
      reason: "Investigate Windows runtime failure",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });
    await expect(
      controller.revokeSession({ id: "admin-1" } as never, "session-1"),
    ).resolves.toEqual({ id: "session-1" });
    expect(revokeSession).toHaveBeenCalledWith("admin-1", "session-1");
    await expect(
      controller.issueSshCertificate({ id: "admin-1" } as never, "session-1", {
        endpointVisibleSourceAddress: "192.168.122.1",
        publicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH5k0JQb4ubKJw4kC9aSxX7IeH8w3OvEu4OR7ow7FJQ9",
        requestId: "550e8400-e29b-41d4-a716-446655440003",
      }),
    ).resolves.toEqual({ serial: 1 });
    expect(issueSshCertificateForHumanSession).toHaveBeenCalledWith(
      "admin-1",
      "session-1",
      {
        endpointVisibleSourceAddress: "192.168.122.1",
        publicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH5k0JQb4ubKJw4kC9aSxX7IeH8w3OvEu4OR7ow7FJQ9",
        requestId: "550e8400-e29b-41d4-a716-446655440003",
      },
    );
  });
});
