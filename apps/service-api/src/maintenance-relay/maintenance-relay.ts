export const MAINTENANCE_RELAY_CHAIN = "VEM-MAINTENANCE-RELAY";

export type RelayPeerRole = "relay" | "runner" | "machine" | "maintainer";

export type RelayPeer = {
  name: string;
  role: RelayPeerRole;
  publicKey: string;
  tunnelIp: string;
  allowedIps?: string[];
  endpoint?: string;
};

export type MaintenanceSession = {
  name: string;
  sourcePeerName: string;
  targetPeerName: string;
  protocol: "tcp";
  ports: number[];
  expiresAt?: string;
};

export type RelayPlan = {
  relay: {
    interfaceName: string;
    address: string;
    listenPort: number;
    endpoint: string;
  };
  peers: RelayPeer[];
  sessions: MaintenanceSession[];
};

export type SafeRelayPlan = RelayPlan & { __safeRelayPlan: true };

export type RelayPlanValidationResult =
  | { ok: true; plan: SafeRelayPlan }
  | { ok: false; errors: string[] };

export type FirewallAllowedFlow = {
  sourcePeerName: string;
  targetPeerName: string;
  protocol: "tcp";
  port: number;
};

export type IptablesPlan = {
  chainName: typeof MAINTENANCE_RELAY_CHAIN;
  commands: string[];
  allowedFlows: FirewallAllowedFlow[];
  deniedByDefault: string[];
};

export type WireGuardSecrets = {
  relayPrivateKey: string;
  peerPrivateKeys: Record<string, string>;
};

export type WireGuardRenderedConfigs = {
  relayConfig: string;
  peerConfigs: Record<string, string>;
};

const SAMPLE_PUBLIC_KEYS = {
  relay: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  runner: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  machine: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
};
const BROAD_ALLOWED_IPS = new Set(["Any", "0.0.0.0/0", "::/0"]);
const WG_BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const ROLE_SEGMENTS: Record<RelayPeerRole, string> = {
  relay: "10.91.0.",
  runner: "10.91.1.",
  machine: "10.91.2.",
  maintainer: "10.91.3.",
};
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isWireGuardKey(value: string): boolean {
  if (!WG_BASE64_KEY_PATTERN.test(value)) return false;
  return Buffer.from(value, "base64").byteLength === 32;
}

function isIpv4Address(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return false;
  return match.slice(1).every((octet) => {
    const octetValue = Number(octet);
    return Number.isInteger(octetValue) && octetValue >= 0 && octetValue <= 255;
  });
}

function isIpv4Cidr(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  if (!address || !prefix || extra !== undefined) return false;
  const prefixLength = Number(prefix);
  return (
    isIpv4Address(address) &&
    Number.isInteger(prefixLength) &&
    prefixLength >= 0 &&
    prefixLength <= 32
  );
}

function isSingleHostAllowedIp(allowedIp: string, tunnelIp: string): boolean {
  return allowedIp === `${tunnelIp}/32`;
}

function roleSegmentCidr(role: RelayPeerRole): string {
  return `${ROLE_SEGMENTS[role]}0/24`;
}

export function buildDefaultMaintenanceRelayPlan(): RelayPlan {
  return {
    relay: {
      interfaceName: "wg-vem-maint",
      address: "10.91.0.1/24",
      listenPort: 51820,
      endpoint: "118.25.104.160:51820",
    },
    peers: [
      {
        name: "relay",
        role: "relay",
        publicKey: SAMPLE_PUBLIC_KEYS.relay,
        tunnelIp: "10.91.0.1",
      },
      {
        name: "github-runner",
        role: "runner",
        publicKey: SAMPLE_PUBLIC_KEYS.runner,
        tunnelIp: "10.91.1.10",
        endpoint: "118.25.104.160:51820",
      },
      {
        name: "win10-vm",
        role: "machine",
        publicKey: SAMPLE_PUBLIC_KEYS.machine,
        tunnelIp: "10.91.2.10",
        endpoint: "118.25.104.160:51820",
      },
    ],
    sessions: [
      {
        name: "runner-to-win10-vm-ssh",
        sourcePeerName: "github-runner",
        targetPeerName: "win10-vm",
        protocol: "tcp",
        ports: [22],
      },
    ],
  };
}

export function validateMaintenanceRelayPlan(
  plan: RelayPlan,
): RelayPlanValidationResult {
  const errors: string[] = [];
  const peerNames = new Set<string>();
  const tunnelIps = new Set<string>();
  const relayPeerCount = plan.peers.filter(
    (peer) => peer.role === "relay",
  ).length;

  if (!isIpv4Cidr(plan.relay.address)) {
    errors.push(`Malformed relay interface address: ${plan.relay.address}`);
  }
  if (relayPeerCount !== 1) {
    errors.push("Maintenance relay plan must contain exactly one relay peer");
  }

  for (const peer of plan.peers) {
    if (!isWireGuardKey(peer.publicKey)) {
      errors.push(`Malformed WireGuard public key for peer ${peer.name}`);
    }
    const hasValidTunnelIp = isIpv4Address(peer.tunnelIp);
    if (!hasValidTunnelIp) {
      errors.push(
        `Malformed tunnel IP for peer ${peer.name}: ${peer.tunnelIp}`,
      );
    }
    if (
      hasValidTunnelIp &&
      !peer.tunnelIp.startsWith(ROLE_SEGMENTS[peer.role])
    ) {
      errors.push(
        `Peer ${peer.name} with role ${peer.role} must use ${roleSegmentCidr(peer.role)}`,
      );
    }
    if (peerNames.has(peer.name)) {
      errors.push(`Duplicate relay peer name: ${peer.name}`);
    }
    peerNames.add(peer.name);
    if (tunnelIps.has(peer.tunnelIp)) {
      errors.push(`Duplicate relay peer tunnel IP: ${peer.tunnelIp}`);
    }
    tunnelIps.add(peer.tunnelIp);
    for (const allowedIp of peer.allowedIps ?? [`${peer.tunnelIp}/32`]) {
      if (BROAD_ALLOWED_IPS.has(allowedIp)) {
        errors.push(`Unsafe AllowedIPs for peer ${peer.name}: ${allowedIp}`);
      } else if (!isIpv4Cidr(allowedIp)) {
        errors.push(`Malformed AllowedIPs for peer ${peer.name}: ${allowedIp}`);
      } else if (!isSingleHostAllowedIp(allowedIp, peer.tunnelIp)) {
        errors.push(`Unsafe AllowedIPs for peer ${peer.name}: ${allowedIp}`);
      }
    }
  }

  const peersByName = new Map(plan.peers.map((peer) => [peer.name, peer]));
  for (const session of plan.sessions) {
    const source = peersByName.get(session.sourcePeerName);
    const target = peersByName.get(session.targetPeerName);
    if (!source) {
      errors.push(
        `Maintenance session references missing source peer: ${session.sourcePeerName}`,
      );
    }
    if (!target) {
      errors.push(
        `Maintenance session references missing target peer: ${session.targetPeerName}`,
      );
    }
    if (source && target) {
      if (source.role !== "runner" || target.role !== "machine") {
        errors.push(
          `Unsafe maintenance session role relationship: ${source.role}-to-${target.role}`,
        );
      }
      for (const port of session.ports) {
        if (port !== 22) {
          errors.push(`Unsupported maintenance session port: ${port}`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { ...plan, __safeRelayPlan: true } };
}

export function renderIptablesPlan(plan: SafeRelayPlan): IptablesPlan {
  const peersByName = new Map(plan.peers.map((peer) => [peer.name, peer]));
  const allowedFlows = plan.sessions.flatMap((session) =>
    session.ports.map((port) => ({
      sourcePeerName: session.sourcePeerName,
      targetPeerName: session.targetPeerName,
      protocol: session.protocol,
      port,
    })),
  );
  const machineSshOutputRejects = plan.peers
    .filter((peer) => peer.role === "machine")
    .flatMap((peer) => [
      `while iptables -D OUTPUT -o ${plan.relay.interfaceName} -d ${peer.tunnelIp}/32 -p tcp --dport 22 -j REJECT 2>/dev/null; do :; done`,
      `iptables -I OUTPUT 1 -o ${plan.relay.interfaceName} -d ${peer.tunnelIp}/32 -p tcp --dport 22 -j REJECT`,
    ]);

  return {
    chainName: MAINTENANCE_RELAY_CHAIN,
    commands: [
      `iptables -N ${MAINTENANCE_RELAY_CHAIN} 2>/dev/null || true`,
      `iptables -F ${MAINTENANCE_RELAY_CHAIN}`,
      `iptables -A ${MAINTENANCE_RELAY_CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
      ...allowedFlows.map((flow) => {
        const source = peersByName.get(flow.sourcePeerName);
        const target = peersByName.get(flow.targetPeerName);
        return `iptables -A ${MAINTENANCE_RELAY_CHAIN} -s ${source?.tunnelIp}/32 -d ${target?.tunnelIp}/32 -p ${flow.protocol} --dport ${flow.port} -m conntrack --ctstate NEW -j ACCEPT`;
      }),
      `iptables -A ${MAINTENANCE_RELAY_CHAIN} -j DROP`,
      `while iptables -D FORWARD -i ${plan.relay.interfaceName} -j ${MAINTENANCE_RELAY_CHAIN} 2>/dev/null; do :; done`,
      `iptables -I FORWARD 1 -i ${plan.relay.interfaceName} -j ${MAINTENANCE_RELAY_CHAIN}`,
      ...machineSshOutputRejects,
    ],
    allowedFlows,
    deniedByDefault: [
      "machine-to-runner",
      "machine-to-machine",
      "relay-to-machine",
      "unstated-peer-forwarding",
    ],
  };
}

function relayPeer(plan: SafeRelayPlan): RelayPeer {
  const relay = plan.peers.find((peer) => peer.role === "relay");
  if (!relay) throw new Error("Safe relay plan is missing relay peer");
  return relay;
}

function activePeerRoutesFor(
  plan: SafeRelayPlan,
  peerName: string,
): RelayPeer[] {
  const peersByName = new Map(plan.peers.map((peer) => [peer.name, peer]));
  const routeNames = new Set<string>();
  for (const session of plan.sessions) {
    if (session.sourcePeerName === peerName) {
      routeNames.add(session.targetPeerName);
    }
    if (session.targetPeerName === peerName) {
      routeNames.add(session.sourcePeerName);
    }
  }
  return Array.from(routeNames)
    .map((routeName) => peersByName.get(routeName))
    .filter((peer): peer is RelayPeer => peer !== undefined);
}

export function renderWireGuardConfigs(
  plan: SafeRelayPlan,
  secrets: WireGuardSecrets,
): WireGuardRenderedConfigs {
  const relay = relayPeer(plan);
  const nonRelayPeers = plan.peers.filter((peer) => peer.role !== "relay");
  const relayConfig = [
    "[Interface]",
    `Address = ${plan.relay.address}`,
    `ListenPort = ${plan.relay.listenPort}`,
    `PrivateKey = ${secrets.relayPrivateKey}`,
    "",
    ...nonRelayPeers.flatMap((peer) => [
      "[Peer]",
      `# ${peer.name}`,
      `PublicKey = ${peer.publicKey}`,
      `AllowedIPs = ${peer.tunnelIp}/32`,
      "",
    ]),
  ].join("\n");

  const peerConfigs = Object.fromEntries(
    nonRelayPeers.map((peer) => {
      const authorizedTargets = activePeerRoutesFor(plan, peer.name);
      const allowedIps = [
        `${relay.tunnelIp}/32`,
        ...authorizedTargets.map((target) => `${target.tunnelIp}/32`),
      ];
      const config = [
        "[Interface]",
        `Address = ${peer.tunnelIp}/32`,
        `PrivateKey = ${secrets.peerPrivateKeys[peer.name] ?? ""}`,
        "",
        "[Peer]",
        "# maintenance-relay",
        `PublicKey = ${relay.publicKey}`,
        `Endpoint = ${plan.relay.endpoint}`,
        `AllowedIPs = ${allowedIps.join(", ")}`,
        "PersistentKeepalive = 25",
        "",
      ].join("\n");
      return [peer.name, config];
    }),
  );

  return { relayConfig, peerConfigs };
}
