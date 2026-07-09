import { describe, expect, it } from "vitest";

import {
  buildDefaultMaintenanceRelayPlan,
  renderIptablesPlan,
  renderWireGuardConfigs,
  validateMaintenanceRelayPlan,
} from "./maintenance-relay";

describe("Maintenance Relay plan tracer", () => {
  it("allows only runner-to-machine SSH in the default fail-closed firewall plan", () => {
    const result = validateMaintenanceRelayPlan(
      buildDefaultMaintenanceRelayPlan(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));

    const firewall = renderIptablesPlan(result.plan);

    expect(firewall.commands).toContain(
      "iptables -A VEM-MAINTENANCE-RELAY -s 10.91.1.10/32 -d 10.91.2.10/32 -p tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT",
    );
    expect(firewall.commands).toContain(
      "iptables -A VEM-MAINTENANCE-RELAY -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    );
    expect(firewall.commands).toContain(
      "iptables -A VEM-MAINTENANCE-RELAY -j DROP",
    );
    expect(firewall.commands).toContain(
      "while iptables -D FORWARD -i wg-vem-maint -j VEM-MAINTENANCE-RELAY 2>/dev/null; do :; done",
    );
    expect(firewall.commands).toContain(
      "iptables -I FORWARD 1 -i wg-vem-maint -j VEM-MAINTENANCE-RELAY",
    );
    expect(firewall.commands).not.toContain(
      "iptables -C FORWARD -i wg-vem-maint -j VEM-MAINTENANCE-RELAY 2>/dev/null || iptables -A FORWARD -i wg-vem-maint -j VEM-MAINTENANCE-RELAY",
    );
    expect(firewall.commands).toContain(
      "while iptables -D OUTPUT -o wg-vem-maint -d 10.91.2.10/32 -p tcp --dport 22 -j REJECT 2>/dev/null; do :; done",
    );
    expect(firewall.commands).toContain(
      "iptables -I OUTPUT 1 -o wg-vem-maint -d 10.91.2.10/32 -p tcp --dport 22 -j REJECT",
    );
    expect(firewall.allowedFlows).toEqual([
      {
        sourcePeerName: "github-runner",
        targetPeerName: "win10-vm",
        protocol: "tcp",
        port: 22,
      },
    ]);
    expect(firewall.deniedByDefault).toEqual([
      "machine-to-runner",
      "machine-to-machine",
      "relay-to-machine",
      "unstated-peer-forwarding",
    ]);
  });

  it("rejects unsafe relay plans before rendering", () => {
    const basePlan = buildDefaultMaintenanceRelayPlan();
    const unsafePlan = {
      ...basePlan,
      peers: [
        ...basePlan.peers,
        {
          name: "github-runner",
          role: "runner" as const,
          publicKey: "not-a-wireguard-key",
          tunnelIp: "10.91.1.10",
          allowedIps: ["Any", "0.0.0.0/0", "::/0", "10.91.0.0/16"],
        },
        {
          name: "future-maintainer",
          role: "maintainer" as const,
          publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          tunnelIp: "10.91.2.20",
        },
      ],
      sessions: [
        ...basePlan.sessions,
        {
          name: "missing-peer",
          sourcePeerName: "github-runner",
          targetPeerName: "missing-machine",
          protocol: "tcp" as const,
          ports: [22],
        },
        {
          name: "machine-to-runner",
          sourcePeerName: "win10-vm",
          targetPeerName: "github-runner",
          protocol: "tcp" as const,
          ports: [22],
        },
        {
          name: "unsupported-port",
          sourcePeerName: "github-runner",
          targetPeerName: "win10-vm",
          protocol: "tcp" as const,
          ports: [3389],
        },
      ],
    };

    expect(validateMaintenanceRelayPlan(unsafePlan)).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "Duplicate relay peer name: github-runner",
        "Duplicate relay peer tunnel IP: 10.91.1.10",
        "Malformed WireGuard public key for peer github-runner",
        "Unsafe AllowedIPs for peer github-runner: Any",
        "Unsafe AllowedIPs for peer github-runner: 0.0.0.0/0",
        "Unsafe AllowedIPs for peer github-runner: ::/0",
        "Unsafe AllowedIPs for peer github-runner: 10.91.0.0/16",
        "Peer future-maintainer with role maintainer must use 10.91.3.0/24",
        "Maintenance session references missing target peer: missing-machine",
        "Unsafe maintenance session role relationship: machine-to-runner",
        "Unsupported maintenance session port: 3389",
      ]),
    });
  });

  it("rejects malformed tunnel addresses and relay peer cardinality", () => {
    const basePlan = buildDefaultMaintenanceRelayPlan();

    const malformedIpPlan = {
      ...basePlan,
      peers: basePlan.peers.map((peer) =>
        peer.name === "github-runner"
          ? { ...peer, tunnelIp: "10.91.1.999" }
          : peer,
      ),
    };

    expect(validateMaintenanceRelayPlan(malformedIpPlan)).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "Malformed tunnel IP for peer github-runner: 10.91.1.999",
      ]),
    });

    expect(
      validateMaintenanceRelayPlan({
        ...basePlan,
        peers: basePlan.peers.filter((peer) => peer.role !== "relay"),
      }),
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "Maintenance relay plan must contain exactly one relay peer",
      ]),
    });

    expect(
      validateMaintenanceRelayPlan({
        ...basePlan,
        peers: [
          ...basePlan.peers,
          {
            name: "backup-relay",
            role: "relay" as const,
            publicKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
            tunnelIp: "10.91.0.2",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "Maintenance relay plan must contain exactly one relay peer",
      ]),
    });
  });

  it("rejects malformed relay CIDRs and peer AllowedIPs", () => {
    const basePlan = buildDefaultMaintenanceRelayPlan();

    expect(
      validateMaintenanceRelayPlan({
        ...basePlan,
        relay: { ...basePlan.relay, address: "10.91.0.1/not-a-prefix" },
      }),
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "Malformed relay interface address: 10.91.0.1/not-a-prefix",
      ]),
    });

    expect(
      validateMaintenanceRelayPlan({
        ...basePlan,
        peers: basePlan.peers.map((peer) =>
          peer.name === "github-runner"
            ? { ...peer, allowedIps: ["10.91.1.10/not-a-prefix"] }
            : peer,
        ),
      }),
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "Malformed AllowedIPs for peer github-runner: 10.91.1.10/not-a-prefix",
      ]),
    });
  });

  it("renders separated WireGuard configs with /32 peer routes only", () => {
    const result = validateMaintenanceRelayPlan(
      buildDefaultMaintenanceRelayPlan(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));

    const configs = renderWireGuardConfigs(result.plan, {
      relayPrivateKey: "relay-private-key-from-secret-store",
      peerPrivateKeys: {
        "github-runner": "runner-private-key-from-secret-store",
        "win10-vm": "machine-private-key-from-secret-store",
      },
    });

    expect(configs.relayConfig).toContain("Address = 10.91.0.1/24");
    expect(configs.relayConfig).toContain("ListenPort = 51820");
    expect(configs.relayConfig).toContain(
      "PrivateKey = relay-private-key-from-secret-store",
    );
    expect(configs.relayConfig).toContain("AllowedIPs = 10.91.1.10/32");
    expect(configs.relayConfig).toContain("AllowedIPs = 10.91.2.10/32");

    expect(configs.peerConfigs["github-runner"]).toContain(
      "Address = 10.91.1.10/32",
    );
    expect(configs.peerConfigs["github-runner"]).toContain(
      "Endpoint = 118.25.104.160:51820",
    );
    expect(configs.peerConfigs["github-runner"]).toContain(
      "AllowedIPs = 10.91.0.1/32, 10.91.2.10/32",
    );
    expect(configs.peerConfigs["win10-vm"]).toContain(
      "AllowedIPs = 10.91.0.1/32, 10.91.1.10/32",
    );

    expect(JSON.stringify(configs)).not.toContain("0.0.0.0/0");
    expect(JSON.stringify(configs)).not.toContain("::/0");
  });
});
