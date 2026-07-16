import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AppConfigService } from "../config/app-config.service";

import { MaintenanceAccessService } from "./maintenance-access.service";
import { parseMaintenanceAddressPools } from "./maintenance-address-pools";

const config = {
  maintenanceAddressPools: parseMaintenanceAddressPools({
    relay: "10.91.0.0/30",
    runner: "10.91.1.0/30",
    maintainer: "10.91.2.0/30",
    machine: "10.91.3.0/30",
  }),
} as AppConfigService;

describe("MaintenanceAccessService", () => {
  it("rejects invalid peer registration contracts before opening a transaction", async () => {
    const transaction = vi.fn();
    const service = new MaintenanceAccessService(
      { transaction } as never,
      config,
    );

    await expect(
      service.registerPeer({
        role: "runner",
        publicKey: "not-a-wireguard-public-key",
        privateKey: "must-not-cross-boundary",
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects endpoint-visible certificate source overrides for human issuance before opening a transaction", async () => {
    const transaction = vi.fn();
    const service = new MaintenanceAccessService(
      { transaction } as never,
      config,
    );

    await expect(
      service.issueSshCertificateForHumanSession(
        "550e8400-e29b-41d4-a716-446655440010",
        "550e8400-e29b-41d4-a716-446655440011",
        {
          endpointVisibleSourceAddress: "192.168.122.1",
          publicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH5k0JQb4ubKJw4kC9aSxX7IeH8w3OvEu4OR7ow7FJQ9",
          requestId: "550e8400-e29b-41d4-a716-446655440012",
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
