import { access, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    expect(
      () => new SyncconfWireGuardBackend("wg-maint_1", "10.91.0.1"),
    ).not.toThrow();
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
      expect(() => new SyncconfWireGuardBackend(invalid, "10.91.0.1")).toThrow(
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

    expect(transaction).not.toContain(
      "delete table inet vem_maintenance_relay",
    );
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
    expect(transaction).toContain("chain input {");
    expect(transaction).not.toMatch(/ct state established,related accept/);
    expect(transaction).not.toContain("iptables");
  });

  it("renders an nftables-valid empty fail-closed state", () => {
    const transaction = renderNftablesTransaction(
      "wg-maint",
      [],
      [],
      new Date("2026-07-10T12:00:00.000Z"),
    );

    expect(transaction).not.toContain("elements = { }");
    expect(transaction).not.toContain("elements = {  }");
    expect(transaction).toContain('iifname "wg-maint" counter drop');
    expect(transaction).toContain('oifname "wg-maint" counter drop');
  });

  it("runs nft as one transaction and WireGuard through syncconf", async () => {
    const command = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const firewall = new NftablesRelayBackend(
      "wg-maint",
      command,
      () => new Date("2026-07-10T12:00:00.000Z"),
    );
    const wireGuard = new SyncconfWireGuardBackend("wg-maint", "10.91.0.1", {
      command,
      runtimeDirectory: tmpdir(),
    });

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
      "ip",
      ["-j", "route", "show", "dev", "wg-maint", "proto", "186"],
    ]);
    expect(command.mock.calls[3]?.slice(0, 2)).toEqual(["ip", ["-batch", "-"]]);
    expect(command.mock.calls[4]?.slice(0, 2)).toEqual([
      "/usr/local/libexec/maintenance-relay-wireguard-syncconf",
      ["wg-maint", expect.any(String), expect.any(String)],
    ]);
  });

  it("keeps the relay identity local and converges remote peer routes without retaining stale routes", async () => {
    let syncconf = "";
    const events: string[] = [];
    const command = vi.fn(
      async (program: string, args: string[], options = {}) => {
        if (program === "ip" && args[0] === "-j") {
          return {
            stdout: JSON.stringify([
              { dst: "10.91.99.9", protocol: 186, dev: "wg-maint" },
            ]),
            stderr: "",
          };
        }
        if (program === "ip") {
          events.push(`routes:${String(options.input)}`);
        }
        if (
          program === "/usr/local/libexec/maintenance-relay-wireguard-syncconf"
        ) {
          syncconf = await readFile(args[2], "utf8");
          events.push("wireguard");
        }
        return { stdout: "", stderr: "" };
      },
    );
    const wireGuard = new SyncconfWireGuardBackend("wg-maint", "10.91.0.1", {
      command,
      runtimeDirectory: tmpdir(),
    });

    await wireGuard.syncPeers([
      {
        id: "550e8400-e29b-41d4-a716-446655440010",
        role: "relay",
        publicKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
        tunnelAddress: "10.91.0.1",
      },
      {
        id: FLOW.sourcePeerId,
        role: "runner",
        publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        tunnelAddress: FLOW.sourceTunnelAddress,
      },
      {
        id: FLOW.targetMachineId,
        role: "machine",
        publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        tunnelAddress: FLOW.targetTunnelAddress,
      },
    ]);

    expect(syncconf).not.toContain("10.91.0.1/32");
    expect(syncconf).toContain("10.91.1.10/32");
    expect(syncconf).toContain("10.91.16.10/32");
    expect(events).toEqual([
      expect.stringContaining("route replace 10.91.1.10/32"),
      "wireguard",
      expect.stringContaining("route del 10.91.99.9/32"),
    ]);
  });

  it("rolls back newly introduced routes and removes staging files when syncconf fails", async () => {
    const routeBatches: string[] = [];
    let peerConfigPath = "";
    const command = vi.fn(
      async (
        program: string,
        args: string[],
        options: { input?: string } = {},
      ) => {
        if (program === "ip" && args[0] === "-j") {
          return {
            stdout: JSON.stringify([{ dst: FLOW.sourceTunnelAddress }]),
            stderr: "",
          };
        }
        if (program === "ip") {
          routeBatches.push(options.input ?? "");
        }
        if (
          program === "/usr/local/libexec/maintenance-relay-wireguard-syncconf"
        ) {
          peerConfigPath = args[2]!;
          expect((await stat(peerConfigPath)).mode & 0o777).toBe(0o600);
          throw new Error("syncconf rejected fixture");
        }
        return { stdout: "", stderr: "" };
      },
    );
    const wireGuard = new SyncconfWireGuardBackend("wg-maint", "10.91.0.1", {
      command,
      runtimeDirectory: tmpdir(),
    });

    await expect(
      wireGuard.syncPeers([
        {
          id: FLOW.sourcePeerId,
          role: "runner",
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          tunnelAddress: FLOW.sourceTunnelAddress,
        },
        {
          id: FLOW.targetMachineId,
          role: "machine",
          publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
          tunnelAddress: FLOW.targetTunnelAddress,
        },
      ]),
    ).rejects.toThrow("syncconf rejected fixture");

    expect(routeBatches).toEqual([
      expect.stringContaining(`route replace ${FLOW.targetTunnelAddress}/32`),
      `route del ${FLOW.targetTunnelAddress}/32 dev wg-maint proto 186 scope link\n`,
    ]);
    await expect(access(peerConfigPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes concurrent interface reconciliations", async () => {
    let activeSyncconfCount = 0;
    let maximumActiveSyncconfCount = 0;
    let helperCallCount = 0;
    let releaseFirstSyncconf!: () => void;
    let markFirstSyncconfStarted!: () => void;
    let markSecondSyncconfStarted!: () => void;
    const firstSyncconfStarted = new Promise<void>((resolve) => {
      markFirstSyncconfStarted = resolve;
    });
    const firstSyncconfRelease = new Promise<void>((resolve) => {
      releaseFirstSyncconf = resolve;
    });
    const secondSyncconfStarted = new Promise<void>((resolve) => {
      markSecondSyncconfStarted = resolve;
    });
    const command = vi.fn(async (program: string, args: string[]) => {
      if (program === "ip" && args[0] === "-j") {
        return { stdout: "[]", stderr: "" };
      }
      if (
        program === "/usr/local/libexec/maintenance-relay-wireguard-syncconf"
      ) {
        helperCallCount += 1;
        activeSyncconfCount += 1;
        maximumActiveSyncconfCount = Math.max(
          maximumActiveSyncconfCount,
          activeSyncconfCount,
        );
        if (helperCallCount === 1) {
          markFirstSyncconfStarted();
          await firstSyncconfRelease;
        } else {
          markSecondSyncconfStarted();
        }
        activeSyncconfCount -= 1;
      }
      return { stdout: "", stderr: "" };
    });
    const wireGuard = new SyncconfWireGuardBackend("wg-maint", "10.91.0.1", {
      command,
      runtimeDirectory: tmpdir(),
    });
    const runner = {
      id: FLOW.sourcePeerId,
      role: "runner" as const,
      publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      tunnelAddress: FLOW.sourceTunnelAddress,
    };
    const machine = {
      id: FLOW.targetMachineId,
      role: "machine" as const,
      publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      tunnelAddress: FLOW.targetTunnelAddress,
    };

    const first = wireGuard.syncPeers([runner]);
    await firstSyncconfStarted;
    const second = wireGuard.syncPeers([machine]);
    await Promise.race([
      secondSyncconfStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
    const observedMaximum = maximumActiveSyncconfCount;
    releaseFirstSyncconf();
    await Promise.all([first, second]);

    expect(helperCallCount).toBe(2);
    expect(observedMaximum).toBe(1);
  });
});
