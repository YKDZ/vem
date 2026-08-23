#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  validateAdminProxyHealth,
  validateDigestPinnedImage,
  validatePaymentWebhookBaseUrl,
} from "./backend-deployment-validation.ts";

const LONG_SECRET_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LONG_SECRET_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LONG_SECRET_C =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const LONG_SECRET_D =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function option(
  args: string[],
  name: string,
  fallback: string | null,
): string | null {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function required(value: string | null | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomPort(base: number): number {
  return base + randomInt(1_000);
}

function runWith(
  exec: typeof execFileSync,
  command: string,
  args: string[],
  options: { quiet?: boolean } = {},
): string {
  const output = exec(command, args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return typeof output === "string" ? output.trim() : "";
}

export function backendComposeSmokeEnv({
  serviceApiImage,
  adminUiImage,
  ports = {},
  volumePrefix = "vem-backend-smoke",
}: {
  serviceApiImage?: string | null;
  adminUiImage?: string | null;
  ports?: Partial<{ serviceApi: number; adminUi: number; mqtt: number }>;
  volumePrefix?: string;
} = {}): Record<string, string> {
  const serviceApiPort = ports.serviceApi ?? randomPort(33_000);
  const adminPort = ports.adminUi ?? randomPort(34_000);
  const mqttPort = ports.mqtt ?? randomPort(36_000);
  const paymentWebhookBaseUrl = "https://payments.example";
  const resolvedServiceApiImage = required(serviceApiImage, "serviceApiImage");
  const resolvedAdminUiImage = required(adminUiImage, "adminUiImage");
  validateDigestPinnedImage(resolvedServiceApiImage, "serviceApiImage");
  validateDigestPinnedImage(resolvedAdminUiImage, "adminUiImage");
  validatePaymentWebhookBaseUrl(paymentWebhookBaseUrl);
  return {
    POSTGRES_DATA_SOURCE: `${volumePrefix}-postgres-data`,
    MQTT_PORT: String(mqttPort),
    MQTT_DATA_SOURCE: `${volumePrefix}-mqtt-data`,
    SERVICE_API_PORT: String(serviceApiPort),
    ADMIN_UI_PORT: String(adminPort),
    SERVICE_API_MEDIA_VOLUME_NAME: `${volumePrefix}-service-api-media-assets`,
    POSTGRES_PASSWORD: "postgres-password",
    MQTT_USERNAME: "vem",
    MQTT_PASSWORD: "mqtt-password",
    SERVICE_API_IMAGE: resolvedServiceApiImage,
    ADMIN_UI_IMAGE: resolvedAdminUiImage,
    JWT_SECRET: LONG_SECRET_A,
    JWT_REFRESH_SECRET: LONG_SECRET_B,
    BOOTSTRAP_ADMIN_PASSWORD: "admin-password",
    MACHINE_JWT_SECRET: LONG_SECRET_C,
    MACHINE_CREDENTIAL_ENCRYPTION_KEY: LONG_SECRET_D,
    MACHINE_CLAIM_LOOKUP_HMAC_KEY: LONG_SECRET_A,
    MACHINE_API_BASE_URL: `http://127.0.0.1:${serviceApiPort}/api`,
    MACHINE_MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`,
    PAYMENT_WEBHOOK_BASE_URL: paymentWebhookBaseUrl,
    PAYMENT_CONFIG_ENCRYPTION_KEY: LONG_SECRET_B,
    PAYMENT_MOCK_ENABLED: "false",
    CORS_ORIGINS: `http://localhost:${adminPort}`,
  };
}

function writeEnvFile(
  path: string,
  values: Record<string, string>,
  write: typeof writeFileSync = writeFileSync,
): void {
  write(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

export function composeCommand({
  project,
  envFile,
  composeFile,
}: {
  project: string;
  envFile: string;
  composeFile: string;
}): string[] {
  return ["compose", "-p", project, "--env-file", envFile, "-f", composeFile];
}

export function targetHostComposeCommand({
  envFile,
  composeFile,
}: {
  envFile: string;
  composeFile: string;
}): string[] {
  return ["compose", "--env-file", envFile, "-f", composeFile];
}

interface SmokeIo {
  execFileSync?: typeof execFileSync;
  writeFileSync?: typeof writeFileSync;
  mkdtempSync?: typeof mkdtempSync;
  rmSync?: typeof rmSync;
  stdout?: NodeJS.WriteStream;
}

export interface BackendComposeSmokeResult {
  schemaVersion: string;
  ok: boolean;
  project: string;
  composeFile: string;
  checks: {
    postgres: string;
    mqtt: string;
    serviceApi: string;
    adminUiProxy: string;
  };
}

export async function runBackendComposeSmoke(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: SmokeIo = {},
): Promise<BackendComposeSmokeResult> {
  const exec = io.execFileSync ?? execFileSync;
  const write = io.writeFileSync ?? writeFileSync;
  const mkdtemp = io.mkdtempSync ?? mkdtempSync;
  const rm = io.rmSync ?? rmSync;
  const stdout = io.stdout ?? process.stdout;
  const run = (
    command: string,
    commandArgs: string[],
    options?: { quiet?: boolean },
  ): string => runWith(exec, command, commandArgs, options);
  const serviceApiImage = option(
    args,
    "--service-api-image",
    env.SERVICE_API_IMAGE ?? null,
  );
  const adminUiImage = option(
    args,
    "--admin-ui-image",
    env.ADMIN_UI_IMAGE ?? null,
  );
  const composeFile = resolve(
    option(args, "--compose", null) ?? "apps/service-api/docker-compose.yml",
  );
  const timeoutSeconds = option(args, "--timeout-seconds", null) ?? "240";
  const keep = hasFlag(args, "--keep");
  const project =
    option(args, "--project", null) ??
    `vem-backend-smoke-${Date.now()}-${process.pid}`;
  const temp = mkdtemp(join(tmpdir(), "vem-backend-smoke-"));
  const envFile = join(temp, "backend.env");
  const smokeEnv = backendComposeSmokeEnv({
    serviceApiImage,
    adminUiImage,
    volumePrefix: project,
  });
  writeEnvFile(envFile, smokeEnv, write);
  const compose = composeCommand({ project, envFile, composeFile });

  try {
    run("docker", [
      ...compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      timeoutSeconds,
    ]);
    const container = (service: string): string =>
      run("docker", [...compose, "ps", "-q", service], { quiet: true });
    const serviceApiContainer = container("service-api");
    const adminUiContainer = container("admin-ui");
    run(
      "docker",
      [
        ...compose,
        "exec",
        "-T",
        "mqtt",
        "mosquitto_pub",
        "-h",
        "localhost",
        "-p",
        "1883",
        "-t",
        "vem/smoke",
        "-m",
        "ok",
        "-u",
        smokeEnv.MQTT_USERNAME,
        "-P",
        smokeEnv.MQTT_PASSWORD,
      ],
      { quiet: true },
    );
    const serviceHealth = run(
      "docker",
      [
        "exec",
        serviceApiContainer,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/api/health').then(async r=>{const t=await r.text(); console.log(t); if(!r.ok) process.exit(1)}).catch(()=>process.exit(1))",
      ],
      { quiet: true },
    );
    const adminProxyHealth = run(
      "docker",
      ["exec", adminUiContainer, "wget", "-qO-", "http://127.0.0.1/api/health"],
      { quiet: true },
    );
    validateAdminProxyHealth(serviceHealth);
    validateAdminProxyHealth(adminProxyHealth);
    const result = {
      schemaVersion: "vem-backend-compose-smoke/v1",
      ok: true,
      project,
      composeFile,
      checks: {
        postgres: "healthy",
        mqtt: "published",
        serviceApi: "healthy",
        adminUiProxy: "healthy",
      },
    };
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (!keep) {
      run("docker", [...compose, "down", "-v", "--remove-orphans"], {
        quiet: true,
      });
      rm(temp, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runBackendComposeSmoke();
}
