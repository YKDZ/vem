#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  buildDefaultMaintenanceRelayPlan,
  renderIptablesPlan,
  renderWireGuardConfigs,
  type RelayPlan,
  type RelayPeerRole,
  validateMaintenanceRelayPlan,
} from "./maintenance-relay";

type Writer = {
  write(chunk: string): unknown;
};

type RenderScope = "all" | "relay" | "peer";

export type MaintenanceRelayCliOptions = {
  dryPlan: boolean;
  format: "json";
  plan: RelayPlan;
  planFile?: string;
  renderScope: RenderScope;
  peerName?: string;
  relayPrivateKey?: string;
  runnerPrivateKey?: string;
  machinePrivateKey?: string;
  peerPrivateKey?: string;
};

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function parseSessionPort(args: string[]): number {
  const raw = readFlag(args, "session-port");
  if (raw === undefined) return 22;
  const port = Number(raw);
  if (!Number.isInteger(port)) {
    throw new Error(`Unsupported maintenance session port: ${raw}`);
  }
  return port;
}

function parseRenderScope(args: string[]): RenderScope {
  const raw = readFlag(args, "render") ?? "all";
  if (raw === "all" || raw === "relay" || raw === "peer") return raw;
  throw new Error(`Unsupported maintenance relay render scope: ${raw}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isRelayPeerRole(value: unknown): value is RelayPeerRole {
  return (
    value === "relay" ||
    value === "runner" ||
    value === "machine" ||
    value === "maintainer"
  );
}

function isRelayPlan(value: unknown): value is RelayPlan {
  if (!isRecord(value)) return false;
  const relay = value["relay"];
  const peers = value["peers"];
  const sessions = value["sessions"];
  if (!isRecord(relay) || !Array.isArray(peers) || !Array.isArray(sessions)) {
    return false;
  }
  if (
    typeof relay["interfaceName"] !== "string" ||
    typeof relay["address"] !== "string" ||
    typeof relay["listenPort"] !== "number" ||
    typeof relay["endpoint"] !== "string"
  ) {
    return false;
  }
  if (
    !peers.every((peer) => {
      if (!isRecord(peer)) return false;
      return (
        typeof peer["name"] === "string" &&
        isRelayPeerRole(peer["role"]) &&
        typeof peer["publicKey"] === "string" &&
        typeof peer["tunnelIp"] === "string" &&
        (peer["allowedIps"] === undefined ||
          isStringArray(peer["allowedIps"])) &&
        (peer["endpoint"] === undefined || typeof peer["endpoint"] === "string")
      );
    })
  ) {
    return false;
  }
  return sessions.every((session) => {
    if (!isRecord(session)) return false;
    return (
      typeof session["name"] === "string" &&
      typeof session["sourcePeerName"] === "string" &&
      typeof session["targetPeerName"] === "string" &&
      session["protocol"] === "tcp" &&
      Array.isArray(session["ports"]) &&
      session["ports"].every((port) => typeof port === "number") &&
      (session["expiresAt"] === undefined ||
        typeof session["expiresAt"] === "string")
    );
  });
}

export function readMaintenanceRelayPlanFile(planFile: string): RelayPlan {
  try {
    const parsed: unknown = JSON.parse(readFileSync(planFile, "utf8"));
    if (!isRelayPlan(parsed)) {
      throw new Error("plan JSON does not match RelayPlan shape");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read maintenance relay plan file ${planFile}: ${message}`,
    );
  }
}

export function parseMaintenanceRelayCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceRelayCliOptions {
  const planFile = readFlag(args, "plan-file");
  const renderScope = parseRenderScope(args);
  const plan = planFile
    ? readMaintenanceRelayPlanFile(planFile)
    : buildDefaultMaintenanceRelayPlan();
  if (readFlag(args, "session-port") !== undefined) {
    const port = parseSessionPort(args);
    plan.sessions = plan.sessions.map((session) => ({
      ...session,
      ports: [port],
    }));
  }

  const validation = validateMaintenanceRelayPlan(plan);
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }

  return {
    dryPlan: args.includes("--dry-plan"),
    format: "json",
    plan,
    planFile,
    renderScope,
    peerName: readFlag(args, "peer"),
    relayPrivateKey:
      readFlag(args, "relay-private-key") ?? env["WG_RELAY_PRIVATE_KEY"],
    runnerPrivateKey:
      readFlag(args, "runner-private-key") ?? env["WG_RUNNER_PRIVATE_KEY"],
    machinePrivateKey:
      readFlag(args, "machine-private-key") ?? env["WG_MACHINE_PRIVATE_KEY"],
    peerPrivateKey:
      readFlag(args, "peer-private-key") ?? env["WG_PEER_PRIVATE_KEY"],
  };
}

export async function runMaintenanceRelayCli(
  args = process.argv.slice(2),
  io: {
    env?: NodeJS.ProcessEnv;
    stdout?: Writer;
    stderr?: Writer;
  } = {},
): Promise<void> {
  const options = parseMaintenanceRelayCliOptions(args, io.env ?? process.env);
  const validation = validateMaintenanceRelayPlan(options.plan);
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }

  const firewall = renderIptablesPlan(validation.plan);
  const publicOutput = {
    relay: validation.plan.relay,
    peers: validation.plan.peers.map((peer) => ({
      name: peer.name,
      role: peer.role,
      publicKey: peer.publicKey,
      tunnelIp: peer.tunnelIp,
    })),
    sessions: validation.plan.sessions,
    firewall,
  };

  if (options.dryPlan) {
    io.stdout?.write(`${JSON.stringify(publicOutput, null, 2)}\n`);
    return;
  }

  const missingSecrets: string[] = [];
  if (options.renderScope === "all" || options.renderScope === "relay") {
    if (!options.relayPrivateKey) missingSecrets.push("WG_RELAY_PRIVATE_KEY");
  }
  if (options.renderScope === "all") {
    if (!options.runnerPrivateKey) missingSecrets.push("WG_RUNNER_PRIVATE_KEY");
    if (!options.machinePrivateKey)
      missingSecrets.push("WG_MACHINE_PRIVATE_KEY");
  }
  const peer = options.peerName
    ? validation.plan.peers.find(
        (candidate) => candidate.name === options.peerName,
      )
    : undefined;
  if (options.renderScope === "peer") {
    if (!peer || peer.role === "relay") {
      throw new Error(
        `Maintenance relay peer render requires a non-relay --peer from the plan: ${options.peerName ?? "<missing>"}`,
      );
    }
    if (
      !options.peerPrivateKey &&
      !(peer.role === "runner" && options.runnerPrivateKey) &&
      !(peer.role === "machine" && options.machinePrivateKey)
    ) {
      missingSecrets.push("WG_PEER_PRIVATE_KEY");
    }
  }
  if (missingSecrets.length > 0) {
    throw new Error(
      `Missing WireGuard private keys from env or flags: ${missingSecrets.join(", ")}`,
    );
  }

  const selectedPeerPrivateKey =
    options.peerPrivateKey ??
    (peer?.role === "runner" ? options.runnerPrivateKey : undefined) ??
    (peer?.role === "machine" ? options.machinePrivateKey : undefined);
  const configs = renderWireGuardConfigs(validation.plan, {
    relayPrivateKey: options.relayPrivateKey ?? "",
    peerPrivateKeys: {
      ...(options.runnerPrivateKey
        ? { "github-runner": options.runnerPrivateKey }
        : {}),
      ...(options.machinePrivateKey
        ? { "win10-vm": options.machinePrivateKey }
        : {}),
      ...(peer && selectedPeerPrivateKey
        ? { [peer.name]: selectedPeerPrivateKey }
        : {}),
    },
  });

  const sensitiveOutput =
    options.renderScope === "relay"
      ? { relayConfig: configs.relayConfig }
      : options.renderScope === "peer" && peer
        ? { peerConfigs: { [peer.name]: configs.peerConfigs[peer.name] } }
        : configs;

  io.stdout?.write(
    `${JSON.stringify({ ...publicOutput, ...sensitiveOutput }, null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runMaintenanceRelayCli(undefined, {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  });
}
