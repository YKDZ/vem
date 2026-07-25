#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateAdminProxyHealth } from "./deploy-backend-stack.mjs";

const LONG_SECRET_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LONG_SECRET_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LONG_SECRET_C =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const LONG_SECRET_D =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomPort(base) {
  return base + randomInt(1_000);
}

function runWith(exec, command, args, options = {}) {
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
} = {}) {
  const adminPort = ports.adminUi ?? randomPort(34_000);
  const mqttPort = ports.mqtt ?? randomPort(36_000);
  return {
    POSTGRES_PORT: String(ports.postgres ?? randomPort(35_000)),
    POSTGRES_DATA_SOURCE: `${volumePrefix}-postgres-data`,
    MQTT_PORT: String(mqttPort),
    MQTT_DATA_SOURCE: `${volumePrefix}-mqtt-data`,
    SERVICE_API_PORT: String(ports.serviceApi ?? randomPort(33_000)),
    ADMIN_UI_PORT: String(adminPort),
    SERVICE_API_MEDIA_VOLUME_NAME: `${volumePrefix}-service-api-media-assets`,
    POSTGRES_PASSWORD: "postgres-password",
    MQTT_USERNAME: "vem",
    MQTT_PASSWORD: "mqtt-password",
    SERVICE_API_IMAGE: required(serviceApiImage, "serviceApiImage"),
    ADMIN_UI_IMAGE: required(adminUiImage, "adminUiImage"),
    JWT_SECRET: LONG_SECRET_A,
    JWT_REFRESH_SECRET: LONG_SECRET_B,
    BOOTSTRAP_ADMIN_PASSWORD: "admin-password",
    MACHINE_JWT_SECRET: LONG_SECRET_C,
    MACHINE_CREDENTIAL_ENCRYPTION_KEY: LONG_SECRET_D,
    MACHINE_CLAIM_LOOKUP_HMAC_KEY: LONG_SECRET_A,
    PAYMENT_WEBHOOK_BASE_URL: "https://payments.example/webhooks",
    PAYMENT_CONFIG_ENCRYPTION_KEY: LONG_SECRET_B,
    PAYMENT_MOCK_ENABLED: "false",
    CORS_ORIGINS: `http://localhost:${adminPort}`,
    MACHINE_MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`,
  };
}

function writeEnvFile(path, values, write = writeFileSync) {
  write(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

export function composeCommand({ project, envFile, composeFile }) {
  return ["compose", "-p", project, "--env-file", envFile, "-f", composeFile];
}

export async function runBackendComposeSmoke(
  args = process.argv.slice(2),
  env = process.env,
  io = {},
) {
  const exec = io.execFileSync ?? execFileSync;
  const write = io.writeFileSync ?? writeFileSync;
  const mkdtemp = io.mkdtempSync ?? mkdtempSync;
  const rm = io.rmSync ?? rmSync;
  const stdout = io.stdout ?? process.stdout;
  const run = (command, commandArgs, options) =>
    runWith(exec, command, commandArgs, options);
  const serviceApiImage = option(
    args,
    "--service-api-image",
    env.SERVICE_API_IMAGE,
  );
  const adminUiImage = option(args, "--admin-ui-image", env.ADMIN_UI_IMAGE);
  const composeFile = resolve(
    option(args, "--compose", "apps/service-api/docker-compose.yml"),
  );
  const timeoutSeconds = option(args, "--timeout-seconds", "240");
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
    const container = (service) =>
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
