import type {
  MaintenancePublicPeer,
  MaintenanceSessionAuthorization,
} from "@vem/shared/schemas/maintenance-access";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RelayFirewallBackend, RelayWireGuardBackend } from "./reconciler";

import { runCommand, type CommandRunner } from "./command";
import { parseLinuxInterfaceName } from "./interface-name";

export class SyncconfWireGuardBackend implements RelayWireGuardBackend {
  private peerIdsByPublicKey = new Map<string, string>();
  private readonly interfaceName: string;

  constructor(
    interfaceName: string,
    private readonly command: CommandRunner = runCommand,
  ) {
    this.interfaceName = parseLinuxInterfaceName(interfaceName);
  }

  async syncPeers(peers: MaintenancePublicPeer[]): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "vem-relay-wg-"));
    const configPath = join(directory, "sync.conf");
    try {
      await writeFile(configPath, renderWireGuardSyncconf(peers), {
        mode: 0o600,
      });
      await this.command("wg", ["syncconf", this.interfaceName, configPath]);
      this.peerIdsByPublicKey = new Map(
        peers.map((peer) => [peer.publicKey, peer.id]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  async observePeers(): Promise<
    Array<{ peerId: string; latestHandshakeAt: string | null }>
  > {
    const { stdout } = await this.command("wg", [
      "show",
      this.interfaceName,
      "dump",
    ]);
    return stdout
      .trim()
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const [publicKey, , , , latestHandshakeSeconds] = line.split("\t");
        const peerId = this.peerIdsByPublicKey.get(publicKey ?? "");
        if (!peerId) return [];
        const seconds = Number(latestHandshakeSeconds);
        return [
          {
            peerId,
            latestHandshakeAt:
              Number.isInteger(seconds) && seconds > 0
                ? new Date(seconds * 1000).toISOString()
                : null,
          },
        ];
      });
  }
}

export class NftablesRelayBackend implements RelayFirewallBackend {
  private readonly interfaceName: string;

  constructor(
    interfaceName: string,
    private readonly command: CommandRunner = runCommand,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.interfaceName = parseLinuxInterfaceName(interfaceName);
  }

  async syncState(
    peers: MaintenancePublicPeer[],
    flows: MaintenanceSessionAuthorization[],
  ): Promise<void> {
    const replaceExisting = await this.tableExists();
    await this.command("nft", ["-f", "-"], {
      input: renderNftablesTransaction(
        this.interfaceName,
        peers.map((peer) => peer.tunnelAddress),
        flows,
        this.now(),
        replaceExisting,
      ),
    });
  }

  private async tableExists(): Promise<boolean> {
    try {
      await this.command("nft", [
        "list",
        "table",
        "inet",
        "vem_maintenance_relay",
      ]);
      return true;
    } catch {
      return false;
    }
  }
}

export function renderWireGuardSyncconf(
  peers: MaintenancePublicPeer[],
): string {
  return [
    "[Interface]",
    "",
    ...peers.flatMap((peer) => [
      "[Peer]",
      `# peer-id=${peer.id}`,
      `PublicKey = ${peer.publicKey}`,
      `AllowedIPs = ${peer.tunnelAddress}/32`,
      "",
    ]),
  ].join("\n");
}

export function renderNftablesTransaction(
  interfaceName: string,
  peerAddresses: string[],
  flows: MaintenanceSessionAuthorization[],
  now: Date,
  replaceExisting = false,
): string {
  const activeFlows = flows
    .map((flow) => ({
      ...flow,
      timeoutSeconds: Math.floor(
        (Date.parse(flow.expiresAt) - now.getTime()) / 1000,
      ),
    }))
    .filter((flow) => flow.timeoutSeconds > 0);
  const elements = activeFlows.map(
    (flow) =>
      `    ${flow.sourceTunnelAddress} . ${flow.targetTunnelAddress} . ${flow.protocol} . ${flow.port} timeout ${flow.timeoutSeconds}s`,
  );

  return [
    ...(replaceExisting
      ? ["delete table inet vem_maintenance_relay"]
      : []),
    "table inet vem_maintenance_relay {",
    "  set active_flows {",
    "    type ipv4_addr . ipv4_addr . inet_proto . inet_service",
    "    flags timeout",
    elements.length > 0 ? "    elements = {" : "    elements = { }",
    ...(elements.length > 0
      ? [
          ...elements.map(
            (element, index) =>
              `${element}${index + 1 < elements.length ? "," : ""}`,
          ),
          "    }",
        ]
      : []),
    "  }",
    "  set managed_peers {",
    "    type ipv4_addr",
    `    elements = { ${peerAddresses.join(", ")} }`,
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    `    iifname "${interfaceName}" oifname "${interfaceName}" ip saddr . ip daddr . meta l4proto . th dport @active_flows counter accept`,
    `    iifname "${interfaceName}" oifname "${interfaceName}" ct state established ip daddr . ip saddr . meta l4proto . th sport @active_flows counter accept`,
    `    iifname "${interfaceName}" counter drop`,
    `    oifname "${interfaceName}" counter drop`,
    "  }",
    "  chain input {",
    "    type filter hook input priority filter; policy accept;",
    `    iifname "${interfaceName}" counter drop`,
    "  }",
    "  chain output {",
    "    type filter hook output priority filter; policy accept;",
    `    oifname "${interfaceName}" counter drop`,
    "  }",
    "}",
    "",
  ].join("\n");
}
