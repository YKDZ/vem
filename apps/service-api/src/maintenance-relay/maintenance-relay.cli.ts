#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  buildDefaultMaintenanceRelayPlan,
  renderIptablesPlan,
  renderWireGuardConfigs,
  type RelayPlan,
  validateMaintenanceRelayPlan,
} from "./maintenance-relay";

type Writer = {
  write(chunk: string): unknown;
};

export type MaintenanceRelayCliOptions = {
  dryPlan: boolean;
  format: "json";
  plan: RelayPlan;
  relayPrivateKey?: string;
  runnerPrivateKey?: string;
  machinePrivateKey?: string;
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
  const raw = readFlag(args, "session-port") ?? "22";
  const port = Number(raw);
  if (!Number.isInteger(port)) {
    throw new Error(`Unsupported maintenance session port: ${raw}`);
  }
  return port;
}

export function parseMaintenanceRelayCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceRelayCliOptions {
  const port = parseSessionPort(args);
  const plan = buildDefaultMaintenanceRelayPlan();
  plan.sessions = plan.sessions.map((session) => ({
    ...session,
    ports: [port],
  }));

  const validation = validateMaintenanceRelayPlan(plan);
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }

  return {
    dryPlan: args.includes("--dry-plan"),
    format: "json",
    plan,
    relayPrivateKey:
      readFlag(args, "relay-private-key") ?? env["WG_RELAY_PRIVATE_KEY"],
    runnerPrivateKey:
      readFlag(args, "runner-private-key") ?? env["WG_RUNNER_PRIVATE_KEY"],
    machinePrivateKey:
      readFlag(args, "machine-private-key") ?? env["WG_MACHINE_PRIVATE_KEY"],
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

  const missingSecrets = [
    ["WG_RELAY_PRIVATE_KEY", options.relayPrivateKey],
    ["WG_RUNNER_PRIVATE_KEY", options.runnerPrivateKey],
    ["WG_MACHINE_PRIVATE_KEY", options.machinePrivateKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingSecrets.length > 0) {
    throw new Error(
      `Missing WireGuard private keys from env or flags: ${missingSecrets.join(", ")}`,
    );
  }

  const configs = renderWireGuardConfigs(validation.plan, {
    relayPrivateKey: options.relayPrivateKey!,
    peerPrivateKeys: {
      "github-runner": options.runnerPrivateKey!,
      "win10-vm": options.machinePrivateKey!,
    },
  });

  io.stdout?.write(
    `${JSON.stringify({ ...publicOutput, ...configs }, null, 2)}\n`,
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
