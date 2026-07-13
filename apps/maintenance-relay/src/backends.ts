import type {
  MaintenancePublicPeer,
  MaintenanceSessionAuthorization,
} from "@vem/shared/schemas/maintenance-access";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";

import type {
  RelayFirewallBackend,
  RelayWireGuardBackend,
} from "./reconciler.js";

import { runCommand, type CommandRunner } from "./command.js";
import { parseLinuxInterfaceName } from "./interface-name.js";

const WIREGUARD_SYNCCONF_HELPER =
  "/usr/local/libexec/maintenance-relay-wireguard-syncconf";
const managedRouteOutputSchema = z.array(
  z.object({ dst: z.string().optional() }),
);

type SyncconfWireGuardBackendOptions = {
  command?: CommandRunner;
  privateKeyPath?: string;
  runtimeDirectory?: string;
};

export class SyncconfWireGuardBackend implements RelayWireGuardBackend {
  private applyQueue: Promise<void> = Promise.resolve();
  private peerIdsByPublicKey = new Map<string, string>();
  private readonly command: CommandRunner;
  private readonly interfaceName: string;
  private readonly privateKeyPath: string;
  private readonly relayTunnelAddress: string;
  private readonly runtimeDirectory: string;

  constructor(
    interfaceName: string,
    relayTunnelAddress: string,
    options: SyncconfWireGuardBackendOptions = {},
  ) {
    this.interfaceName = parseLinuxInterfaceName(interfaceName);
    if (isIP(relayTunnelAddress) !== 4) {
      throw new Error("relay tunnel address must be IPv4");
    }
    this.relayTunnelAddress = relayTunnelAddress;
    this.command = options.command ?? runCommand;
    this.privateKeyPath =
      options.privateKeyPath ?? "/run/secrets/maintenance_relay_private_key";
    this.runtimeDirectory =
      options.runtimeDirectory ?? "/run/vem/maintenance-relay";
  }

  async syncPeers(peers: MaintenancePublicPeer[]): Promise<void> {
    const peerSnapshot = peers.map((peer) => ({ ...peer }));
    const apply = this.applyQueue.then(async () => {
      await this.applyPeers(peerSnapshot);
    });
    this.applyQueue = apply.catch(() => undefined);
    await apply;
  }

  private async applyPeers(peers: MaintenancePublicPeer[]): Promise<void> {
    const remotePeers = peers.filter((peer) => {
      if (peer.role === "relay") {
        if (peer.tunnelAddress !== this.relayTunnelAddress) {
          throw new Error("desired state contains a foreign relay identity");
        }
        return false;
      }
      if (peer.tunnelAddress === this.relayTunnelAddress) {
        throw new Error("remote peer collides with the relay tunnel address");
      }
      return true;
    });
    const existingRoutes = await this.readManagedRoutes();
    const desiredRoutes = new Set(
      remotePeers.map((peer) => `${peer.tunnelAddress}/32`),
    );
    const existingRouteSet = new Set(existingRoutes);
    const introducedRoutes = [...desiredRoutes].filter(
      (route) => !existingRouteSet.has(route),
    );
    await this.applyRouteBatch(
      [...desiredRoutes].map(
        (route) =>
          `route replace ${route} dev ${this.interfaceName} proto 186 scope link`,
      ),
    );
    try {
      const directory = await mkdtemp(
        join(this.runtimeDirectory, "vem-relay-wg-"),
      );
      const configPath = join(directory, "peers.conf");
      try {
        await writeFile(configPath, renderWireGuardPeerConfig(remotePeers), {
          mode: 0o600,
        });
        await this.command(WIREGUARD_SYNCCONF_HELPER, [
          this.interfaceName,
          this.privateKeyPath,
          configPath,
        ]);
        this.peerIdsByPublicKey = new Map(
          remotePeers.map((peer) => [peer.publicKey, peer.id]),
        );
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    } catch (error) {
      try {
        await this.applyRouteBatch(
          introducedRoutes.map(
            (route) =>
              `route del ${route} dev ${this.interfaceName} proto 186 scope link`,
          ),
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "WireGuard syncconf failed and managed route rollback failed",
        );
      }
      throw error;
    }
    await this.applyRouteBatch(
      existingRoutes
        .filter((route) => !desiredRoutes.has(route))
        .map(
          (route) =>
            `route del ${route} dev ${this.interfaceName} proto 186 scope link`,
        ),
    );
  }

  private async readManagedRoutes(): Promise<string[]> {
    const { stdout } = await this.command("ip", [
      "-j",
      "route",
      "show",
      "dev",
      this.interfaceName,
      "proto",
      "186",
    ]);
    if (!stdout.trim()) return [];
    const routes = managedRouteOutputSchema.safeParse(JSON.parse(stdout));
    if (!routes.success) {
      throw new Error("ip route returned an invalid JSON payload");
    }
    return routes.data.flatMap((route) => {
      const destination = route.dst;
      if (typeof destination !== "string") return [];
      const address = destination.endsWith("/32")
        ? destination.slice(0, -3)
        : destination;
      return isIP(address) === 4 ? [`${address}/32`] : [];
    });
  }

  private async applyRouteBatch(commands: string[]): Promise<void> {
    if (commands.length === 0) return;
    await this.command("ip", ["-batch", "-"], {
      input: `${commands.join("\n")}\n`,
    });
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

export function renderWireGuardPeerConfig(
  peers: MaintenancePublicPeer[],
): string {
  return peers
    .flatMap((peer) => [
      "[Peer]",
      `# peer-id=${peer.id}`,
      `PublicKey = ${peer.publicKey}`,
      `AllowedIPs = ${peer.tunnelAddress}/32`,
      "",
    ])
    .join("\n");
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
    ...(replaceExisting ? ["delete table inet vem_maintenance_relay"] : []),
    "table inet vem_maintenance_relay {",
    "  set active_flows {",
    "    type ipv4_addr . ipv4_addr . inet_proto . inet_service",
    "    flags timeout",
    ...(elements.length > 0
      ? [
          "    elements = {",
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
    ...(peerAddresses.length > 0
      ? [`    elements = { ${peerAddresses.join(", ")} }`]
      : []),
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
