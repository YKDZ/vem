import type { MaintenanceRelayTransport } from "@vem/shared/schemas/maintenance-access";

import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import { parseLinuxInterfaceName } from "./interface-name.js";
import { resolveServiceApiTransport } from "./transport.js";

export type RelayRuntimeConfig = {
  serviceApiBaseUrl: string;
  credentialFile: string;
  privateKeyFile: string;
  interfaceName: string;
  relayTunnelAddress: string;
  pollIntervalMs: number;
  journalPath: string;
  healthHost: "127.0.0.1";
  healthPort: number;
  transport: MaintenanceRelayTransport;
};

type Environment = Record<string, string | undefined>;

export function parseRelayRuntimeConfig(env: Environment): RelayRuntimeConfig {
  const serviceApiBaseUrl = requiredEnv(env, "SERVICE_API_BASE_URL");
  const relayTunnelAddress = requiredEnv(
    env,
    "MAINTENANCE_RELAY_TUNNEL_ADDRESS",
  );
  if (isIP(relayTunnelAddress) !== 4) {
    throw new Error("MAINTENANCE_RELAY_TUNNEL_ADDRESS must be an IPv4 address");
  }
  const allowInsecureHttp = parseBoolean(
    env["MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP"],
    "MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP",
  );
  const configuredHealthHost = env["MAINTENANCE_RELAY_HEALTH_HOST"];
  if (configuredHealthHost && configuredHealthHost !== "127.0.0.1") {
    throw new Error("management health is fixed to 127.0.0.1");
  }
  return {
    serviceApiBaseUrl,
    credentialFile:
      env["MAINTENANCE_RELAY_CREDENTIAL_FILE"] ??
      "/run/secrets/maintenance_relay_credential",
    privateKeyFile:
      env["MAINTENANCE_RELAY_PRIVATE_KEY_PATH"] ??
      "/run/secrets/maintenance_relay_private_key",
    relayTunnelAddress,
    interfaceName: parseLinuxInterfaceName(
      env["MAINTENANCE_RELAY_INTERFACE"] ?? "wg0",
    ),
    pollIntervalMs: parsePositiveInteger(
      env["MAINTENANCE_RELAY_POLL_INTERVAL_MS"] ?? "5000",
      "MAINTENANCE_RELAY_POLL_INTERVAL_MS",
      1000,
      Number.MAX_SAFE_INTEGER,
    ),
    journalPath:
      env["MAINTENANCE_RELAY_JOURNAL_PATH"] ??
      "/run/vem/maintenance-relay/journal.json",
    healthHost: "127.0.0.1",
    healthPort: parsePositiveInteger(
      env["MAINTENANCE_RELAY_HEALTH_PORT"] ?? "8080",
      "MAINTENANCE_RELAY_HEALTH_PORT",
      1,
      65_535,
    ),
    transport: resolveServiceApiTransport(serviceApiBaseUrl, allowInsecureHttp),
  };
}

export async function readRelayCredential(path: string): Promise<string> {
  const credential = (await readFile(path, "utf8")).trim();
  if (credential.length < 32 || credential.length > 512) {
    throw new Error("maintenance relay credential file is invalid");
  }
  return credential;
}

function requiredEnv(env: Environment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(
  value: string,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
