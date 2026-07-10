import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseRelayRuntimeConfig,
  readRelayCredential,
} from "./runtime-config";

const baseEnv = {
  SERVICE_API_BASE_URL: "https://service-api.example/api",
  MAINTENANCE_RELAY_TUNNEL_ADDRESS: "10.91.0.1",
};

describe("maintenance relay runtime configuration", () => {
  it("defaults to HTTPS, internal health, and tmpfs-backed relay state", () => {
    expect(parseRelayRuntimeConfig(baseEnv)).toMatchObject({
      interfaceName: "wg0",
      relayTunnelAddress: "10.91.0.1",
      pollIntervalMs: 5000,
      journalPath: "/run/vem/maintenance-relay/journal.json",
      healthHost: "127.0.0.1",
      healthPort: 8080,
      transport: { mode: "https", health: "healthy", reason: null },
    });
  });

  it("requires an explicit IPv4 relay tunnel identity", () => {
    const { MAINTENANCE_RELAY_TUNNEL_ADDRESS: _, ...missing } = baseEnv;
    expect(() => parseRelayRuntimeConfig(missing)).toThrow(
      "MAINTENANCE_RELAY_TUNNEL_ADDRESS is required",
    );
    expect(() =>
      parseRelayRuntimeConfig({
        ...baseEnv,
        MAINTENANCE_RELAY_TUNNEL_ADDRESS: "fd00::1",
      }),
    ).toThrow("must be an IPv4 address");
  });

  it("reports an explicit private insecure HTTP exception as degraded", () => {
    expect(
      parseRelayRuntimeConfig({
        ...baseEnv,
        SERVICE_API_BASE_URL: "http://service-api:26849/api",
        MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP: "true",
      }).transport,
    ).toEqual({
      mode: "insecure-http",
      health: "degraded",
      reason: "Service API uses explicitly allowed insecure HTTP",
    });
  });

  it("rejects an invalid health bind override and public insecure HTTP", () => {
    expect(() =>
      parseRelayRuntimeConfig({
        ...baseEnv,
        MAINTENANCE_RELAY_HEALTH_HOST: "0.0.0.0",
      }),
    ).toThrow("management health is fixed to 127.0.0.1");
    expect(() =>
      parseRelayRuntimeConfig({
        ...baseEnv,
        SERVICE_API_BASE_URL: "http://service-api.example/api",
        MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP: "true",
      }),
    ).toThrow("insecure HTTP destination is not private");
  });

  it("reads the relay credential directly from its file and never projects an environment secret", async () => {
    const directory = await mkdtemp(
      join("/dev/shm", "vem-relay-runtime-config-"),
    );
    const credentialFile = join(directory, "credential");
    try {
      await writeFile(
        credentialFile,
        "file-credential-at-least-thirty-two-bytes\n",
        { mode: 0o400 },
      );
      const config = parseRelayRuntimeConfig({
        ...baseEnv,
        MAINTENANCE_RELAY_CREDENTIAL: "environment-secret-must-be-ignored",
        MAINTENANCE_RELAY_CREDENTIAL_FILE: credentialFile,
      });

      expect(config).not.toHaveProperty("credential");
      await expect(readRelayCredential(config.credentialFile)).resolves.toBe(
        "file-credential-at-least-thirty-two-bytes",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
