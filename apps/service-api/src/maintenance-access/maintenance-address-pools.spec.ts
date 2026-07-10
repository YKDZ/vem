import { describe, expect, it } from "vitest";

import {
  allocateTunnelAddress,
  parseMaintenanceAddressPools,
} from "./maintenance-address-pools";

describe("Maintenance address pools", () => {
  it("validates non-overlapping deployment-configured role pools and allocates /32 host addresses", () => {
    const pools = parseMaintenanceAddressPools({
      relay: "10.91.0.0/24",
      runner: "10.91.1.0/24",
      maintainer: "10.91.3.0/24",
      machine: "10.91.16.0/20",
    });

    expect(allocateTunnelAddress(pools.runner, new Set())).toBe("10.91.1.1");
    expect(allocateTunnelAddress(pools.runner, new Set(["10.91.1.1"]))).toBe(
      "10.91.1.2",
    );
  });

  it("rejects overlapping pools and exhausted host space", () => {
    expect(() =>
      parseMaintenanceAddressPools({
        relay: "10.91.0.0/24",
        runner: "10.91.0.128/25",
        maintainer: "10.91.3.0/24",
        machine: "10.91.16.0/20",
      }),
    ).toThrow("must not overlap");

    const pools = parseMaintenanceAddressPools({
      relay: "10.1.0.0/30",
      runner: "10.1.1.0/30",
      maintainer: "10.1.2.0/30",
      machine: "10.1.3.0/30",
    });
    expect(() =>
      allocateTunnelAddress(pools.runner, new Set(["10.1.1.1", "10.1.1.2"])),
    ).toThrow("exhausted");
  });
});
