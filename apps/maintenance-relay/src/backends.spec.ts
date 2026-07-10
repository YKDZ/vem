import { describe, expect, it, vi } from "vitest";

import {
  NftablesRelayBackend,
  SyncconfWireGuardBackend,
  renderNftablesTransaction,
} from "./backends";

const FLOW = {
  sessionId: "550e8400-e29b-41d4-a716-446655440003",
  sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
  sourceTunnelAddress: "10.91.1.10",
  targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
  targetTunnelAddress: "10.91.16.10",
  protocol: "tcp" as const,
  port: 22 as const,
  expiresAt: "2026-07-10T12:30:00.000Z",
};

describe("relay command backends", () => {
  it("accepts only safe Linux interface names", () => {
    expect(() => new NftablesRelayBackend("wg0")).not.toThrow();
    expect(() => new SyncconfWireGuardBackend("wg-maint_1")).not.toThrow();
    for (const invalid of [
      "",
      ".",
      "..",
      "abcdefghijklmnop",
      "wg 0",
      "wg/0",
      'wg0" drop',
    ]) {
      expect(() => new NftablesRelayBackend(invalid)).toThrow(
        "invalid Linux interface name",
      );
      expect(() => new SyncconfWireGuardBackend(invalid)).toThrow(
        "invalid Linux interface name",
      );
    }
  });

  it("binds both directions to one expiring tuple and denies every WireGuard boundary by default", () => {
    const transaction = renderNftablesTransaction(
      "wg-maint",
      [FLOW.sourceTunnelAddress, FLOW.targetTunnelAddress],
      [FLOW],
      new Date("2026-07-10T12:00:00.000Z"),
    );

    expect(transaction).not.toContain("delete table inet vem_maintenance_relay");
    expect(transaction).toContain("table inet vem_maintenance_relay");
    expect(transaction).toContain(
      "10.91.1.10 . 10.91.16.10 . tcp . 22 timeout 1800s",
    );
    expect(transaction).toContain(
      'iifname "wg-maint" oifname "wg-maint" ip saddr . ip daddr . meta l4proto . th dport @active_flows counter accept',
    );
    expect(transaction).toContain(
      'iifname "wg-maint" oifname "wg-maint" ct state established ip daddr . ip saddr . meta l4proto . th sport @active_flows counter accept',
    );
    expect(transaction).toContain('iifname "wg-maint" counter drop');
    expect(transaction).toContain('oifname "wg-maint" counter drop');
    expect(transaction).toContain('chain input {');
    expect(transaction).not.toMatch(/ct state established,related accept/);
    expect(transaction).not.toContain("iptables");
  });

  it("runs nft as one transaction and WireGuard through syncconf", async () => {
    const command = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const firewall = new NftablesRelayBackend(
      "wg-maint",
      command,
      () => new Date("2026-07-10T12:00:00.000Z"),
    );
    const wireGuard = new SyncconfWireGuardBackend("wg-maint", command);

    const peers = [
      {
        id: FLOW.sourcePeerId,
        role: "runner" as const,
        publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        tunnelAddress: FLOW.sourceTunnelAddress,
      },
    ];
    await firewall.syncState(peers, [FLOW]);
    await wireGuard.syncPeers(peers);

    expect(command.mock.calls[0]).toEqual([
      "nft",
      ["list", "table", "inet", "vem_maintenance_relay"],
    ]);
    expect(command.mock.calls[1]).toEqual([
      "nft",
      ["-f", "-"],
      expect.objectContaining({
        input: expect.stringContaining("active_flows"),
      }),
    ]);
    expect(command.mock.calls[2]?.slice(0, 2)).toEqual([
      "wg",
      ["syncconf", "wg-maint", expect.any(String)],
    ]);
  });
});
