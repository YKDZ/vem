#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FIXTURE_PATH = new URL(
  "./fixtures/local-testbed-catalog.json",
  import.meta.url,
);
const SERVICE_NAMES = Object.freeze({
  postgres: "vem-local-testbed-postgres",
  mqtt: "vem-local-testbed-mosquitto",
});
const VOLUME_NAMES = Object.freeze({
  postgres: "vem-local-testbed-postgres-data",
  mqtt: "vem-local-testbed-mosquitto-data",
});
const SERVICE_API_UNIT = "vem-local-testbed-service-api";
const HOST_CONTROL_PLANE_UNIT = "vem-local-testbed-host-control-plane";
const GUEST_HANDOFF_PATH =
  "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json";
const GUEST_SMOKE_PATH =
  "C:\\ProgramData\\VEM\\testbed\\installed-runtime-smoke.json";
const GUEST_VISION_MOCK_CONTROL_PORT = 7893;
const HOST_CONTROL_PLANE_PORT = 26851;
const MODES = new Set(["fast", "full", "clear_cache"]);
const REQUIRED_SERVICE_API_ENV_KEYS = Object.freeze([
  "NODE_ENV",
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "MACHINE_JWT_SECRET",
  "MACHINE_CREDENTIAL_ENCRYPTION_KEY",
  "MACHINE_CLAIM_LOOKUP_HMAC_KEY",
  "CORS_ORIGINS",
  "MQTT_URL",
  "MACHINE_MQTT_URL",
  "MAINTENANCE_RELAY_ADDRESS_POOL",
  "MAINTENANCE_RUNNER_ADDRESS_POOL",
  "MAINTENANCE_MAINTAINER_ADDRESS_POOL",
  "MAINTENANCE_MACHINE_ADDRESS_POOL",
  "MAINTENANCE_RELAY_PEER_ID",
  "MAINTENANCE_RELAY_ENDPOINT",
  "MAINTENANCE_RELAY_PUBLIC_KEY",
  "MAINTENANCE_RELAY_TUNNEL_ADDRESS",
  "MAINTENANCE_RELAY_CREDENTIAL",
  "MAINTENANCE_RELAY_JWT_SECRET",
  "PAYMENT_MOCK_ENABLED",
  "PAYMENT_WEBHOOK_BASE_URL",
  "MACHINE_API_BASE_URL",
  "MEDIA_ASSET_STORAGE_ROOT",
  "PAYMENT_CONFIG_ENCRYPTION_KEY",
  "BOOTSTRAP_ADMIN_USERNAME",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "SERVICE_HOST",
  "SERVICE_PORT",
]);
const COMMAND_ENV_PASSTHROUGH = Object.freeze([
  "CI",
  "COREPACK_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "PNPM_HOME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_RUNTIME_DIR",
]);

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function absolute(value, label) {
  const path = required(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function commandArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== "string" || part.trim() === "") ||
    !isAbsolute(value[0])
  ) {
    throw new Error(
      `${label} must be a non-empty command array with an absolute executable`,
    );
  }
  return value;
}

function trackedHostCommand(value, action, label) {
  const command = commandArray(value, label);
  if (
    !["node", "nodejs"].includes(basename(command[0])) ||
    command[1] !== "{repository}/scripts/testbed/local-testbed-host.mjs" ||
    command[2] !== action
  ) {
    throw new Error(
      `${label} must invoke the tracked local-testbed-host.mjs ${action} action`,
    );
  }
  return command;
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function option(args, name, optional = false) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    if (optional) return undefined;
    throw new Error(`--${name} is required`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function isObservedIpv4(entry) {
  return entry?.family === "IPv4" || entry?.family === 4;
}

function observedNonLoopbackIpv4Addresses(observeNetworkInterfaces) {
  const observed = observeNetworkInterfaces();
  const addresses = new Set();
  for (const entries of Object.values(observed ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (
        entry &&
        typeof entry.address === "string" &&
        isObservedIpv4(entry) &&
        entry.internal !== true &&
        !entry.address.startsWith("127.")
      ) {
        addresses.add(entry.address);
      }
    }
  }
  return addresses;
}

export function validateHostPrivateAddress(
  hostPrivateAddress,
  { observeNetworkInterfaces = networkInterfaces } = {},
) {
  if (isIP(hostPrivateAddress) !== 4 || hostPrivateAddress.startsWith("127.")) {
    throw new Error(
      "--host-private-address must be a non-loopback IPv4 address",
    );
  }
  if (
    !observedNonLoopbackIpv4Addresses(observeNetworkInterfaces).has(
      hostPrivateAddress,
    )
  ) {
    throw new Error(
      "--host-private-address must match a non-loopback IPv4 interface on this host",
    );
  }
  return hostPrivateAddress;
}

export function parseOptions(
  args,
  { observeNetworkInterfaces = networkInterfaces } = {},
) {
  const command = args[0];
  if (command !== "reconstruct") {
    throw new Error(
      "usage: local-testbed.mjs reconstruct --mode fast|full|clear_cache ...",
    );
  }
  const mode = option(args, "mode");
  if (!MODES.has(mode))
    throw new Error("--mode must be fast, full, or clear_cache");
  const hostPrivateAddress = validateHostPrivateAddress(
    option(args, "host-private-address"),
    { observeNetworkInterfaces },
  );
  return {
    command,
    mode,
    runId: required(option(args, "run-id"), "--run-id"),
    workspace: absolute(option(args, "workspace"), "--workspace"),
    stateRoot: absolute(option(args, "state-root"), "--state-root"),
    baselineContract: absolute(
      option(args, "baseline-contract"),
      "--baseline-contract",
    ),
    hostPrivateAddress,
    out: absolute(option(args, "out"), "--out"),
    dryRun: args.includes("--dry-run"),
  };
}

export function validateBaselineContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("baseline contract must be an object");
  }
  if (contract.schemaVersion !== "win10-kvm-baseline-current/v1") {
    throw new Error(
      "baseline contract must be the published win10-kvm-baseline-current/v1 manifest",
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/i.test(contract.releaseId ?? "")) {
    throw new Error("published baseline contract releaseId is invalid");
  }
  if (!contract.destinations || !contract.artifacts || !contract.testbed) {
    throw new Error(
      "published baseline contract must include destinations, artifacts, and testbed",
    );
  }
  for (const [container, keys] of [
    [contract.destinations, ["baselinePath", "cacheDiskPath"]],
    [
      contract.artifacts,
      ["systemPath", "cachePath", "domainXmlPath", "diagnosticPath"],
    ],
  ]) {
    for (const key of keys) {
      absolute(container[key], `baseline contract ${key}`);
    }
  }
  const binding = contract.testbed;
  trackedHostCommand(
    binding.reconstructCommand,
    "reconstruct",
    "baseline contract testbed.reconstructCommand",
  );
  trackedHostCommand(
    binding.admitRunnerCommand,
    "admit",
    "baseline contract testbed.admitRunnerCommand",
  );
  if (!binding.guest || typeof binding.guest !== "object") {
    throw new Error("baseline contract guest is required");
  }
  for (const key of [
    "host",
    "user",
    "identityFile",
    "knownHostsFile",
    "stagingPath",
    "cacheRoot",
  ]) {
    required(binding.guest[key], `baseline contract guest.${key}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(binding.guest.host)) {
    throw new Error(
      "baseline contract guest.host must be a hostname or IP address",
    );
  }
  if (
    !isAbsolute(binding.guest.identityFile) ||
    !isAbsolute(binding.guest.knownHostsFile)
  ) {
    throw new Error("baseline contract SSH files must be absolute");
  }
  windowsAbsolute(
    binding.guest.stagingPath,
    "baseline contract guest.stagingPath",
  );
  windowsAbsolute(binding.guest.cacheRoot, "baseline contract guest.cacheRoot");
  return contract;
}

async function loadFixture() {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  if (
    fixture.schemaVersion !== "vem-local-testbed-catalog/v1" ||
    !Array.isArray(fixture.products)
  ) {
    throw new Error("local testbed catalog fixture is invalid");
  }
  const rows = new Set(fixture.products.map((product) => product.sourceRow));
  if (fixture.products.length !== 44 || rows.size !== fixture.products.length) {
    throw new Error(
      "local testbed catalog must contain the 44 normalized spreadsheet rows",
    );
  }
  return fixture;
}

function commandLine(command, args, extra = {}) {
  return { command, args: args.map(String), ...extra };
}

function runtimeBaseIdentity(contract) {
  return `runtime-base://sha256/${createHash("sha256")
    .update(
      JSON.stringify({
        releaseId: contract.releaseId,
        baselinePath: contract.destinations?.baselinePath,
        systemPath: contract.artifacts?.systemPath,
      }),
    )
    .digest("hex")}`;
}

function runtimeTargetIdentity(contract) {
  return `vm-target://${String(contract.releaseId).toLowerCase()}`;
}

function renderPublishedCommand(command, options, contract) {
  const guest = contract.testbed.guest;
  const replacements = {
    repository: options.workspace,
    runId: options.runId,
    hostPrivateAddress: options.hostPrivateAddress,
    systemPath: contract.artifacts.systemPath,
    cachePath: contract.artifacts.cachePath,
    domainXmlPath: contract.artifacts.domainXmlPath,
    guestHost: guest.host,
    guestUser: guest.user,
    identityFile: guest.identityFile,
    knownHostsFile: guest.knownHostsFile,
    guestStagingPath: guest.stagingPath,
  };
  const rendered = command.map((part) =>
    Object.entries(replacements).reduce(
      (value, [name, replacement]) =>
        value.replaceAll(`{${name}}`, replacement),
      part,
    ),
  );
  const unresolved = rendered.find((part) => /\{[^{}]+\}/.test(part));
  if (unresolved) {
    throw new Error(
      `baseline testbed command has an unknown placeholder: ${unresolved}`,
    );
  }
  return commandLine(rendered[0], rendered.slice(1));
}

export function buildReconstructionPlan(options, contract) {
  const state = options.stateRoot;
  const binding = contract.testbed;
  const sshArgs = [
    "-i",
    binding.guest.identityFile,
    "-o",
    `UserKnownHostsFile=${binding.guest.knownHostsFile}`,
    `${binding.guest.user}@${binding.guest.host}`,
  ];
  return [
    commandLine("docker", [
      "rm",
      "-f",
      SERVICE_NAMES.postgres,
      SERVICE_NAMES.mqtt,
    ]),
    commandLine("docker", [
      "volume",
      "rm",
      "-f",
      VOLUME_NAMES.postgres,
      VOLUME_NAMES.mqtt,
    ]),
    renderPublishedCommand(binding.reconstructCommand, options, contract),
    commandLine("docker", ["volume", "create", VOLUME_NAMES.postgres]),
    commandLine("docker", ["volume", "create", VOLUME_NAMES.mqtt]),
    commandLine("docker", [
      "run",
      "-d",
      "--name",
      SERVICE_NAMES.postgres,
      "--restart",
      "no",
      "-e",
      "POSTGRES_DB=vem_local_testbed",
      "-e",
      "POSTGRES_USER=vem",
      "-e",
      "POSTGRES_PASSWORD=vem_local_testbed_password",
      "-v",
      `${VOLUME_NAMES.postgres}:/var/lib/postgresql/data`,
      "-p",
      "55432:5432",
      "postgres:16",
    ]),
    commandLine("docker", [
      "run",
      "-d",
      "--name",
      SERVICE_NAMES.mqtt,
      "--restart",
      "no",
      "-v",
      `${join(state, "mosquitto.conf")}:/mosquitto/config/mosquitto.conf:ro`,
      "-v",
      `${VOLUME_NAMES.mqtt}:/mosquitto/data`,
      "-p",
      "18883:1883",
      "eclipse-mosquitto:2",
    ]),
    commandLine("pnpm", [
      "turbo",
      "build",
      "--filter",
      "@vem/shared",
      "--filter",
      "@vem/db",
      "--filter",
      "service-api",
    ]),
    commandLine("pnpm", ["--filter", "@vem/db", "migrate"], {
      env: buildMigrationEnvironment(options),
    }),
    commandLine("ssh", [
      ...sshArgs,
      `powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${binding.guest.stagingPath}') | Out-Null\"`,
    ]),
    commandLine("scp", [
      "-i",
      binding.guest.identityFile,
      "-o",
      `UserKnownHostsFile=${binding.guest.knownHostsFile}`,
      join(state, "guest-input.json"),
      `${binding.guest.user}@${binding.guest.host}:${binding.guest.stagingPath}`,
    ]),
    renderPublishedCommand(binding.admitRunnerCommand, options, contract),
  ];
}

export function buildHostLocalServiceApiEnvironment(options) {
  return {
    NODE_ENV: "development",
    DATABASE_URL:
      "postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed",
    MQTT_URL: "mqtt://127.0.0.1:18883",
    MACHINE_MQTT_URL: `mqtt://${options.hostPrivateAddress}:18883`,
    MACHINE_API_BASE_URL: `http://${options.hostPrivateAddress}:26849/api`,
    PAYMENT_WEBHOOK_BASE_URL: `http://${options.hostPrivateAddress}:26849`,
    PAYMENT_MOCK_ENABLED: "true",
    CORS_ORIGINS: [
      "http://127.0.0.1:1420",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ].join(","),
    SERVICE_HOST: "0.0.0.0",
    SERVICE_PORT: "26849",
    BOOTSTRAP_ADMIN_USERNAME: "local-testbed-admin",
    BOOTSTRAP_ADMIN_PASSWORD: "LocalTestbedAdminPassword!",
    JWT_SECRET: "local-testbed-jwt-secret-at-least-32-characters",
    JWT_REFRESH_SECRET: "local-testbed-refresh-secret-at-least-32-characters",
    MACHINE_JWT_SECRET: "local-testbed-machine-jwt-secret-at-least-32-chars",
    MACHINE_CREDENTIAL_ENCRYPTION_KEY:
      "local-testbed-machine-credential-key-32-chars",
    MACHINE_CLAIM_LOOKUP_HMAC_KEY: "local-testbed-machine-claim-lookup-key-v1",
    MAINTENANCE_RELAY_ADDRESS_POOL: "10.91.0.0/24",
    MAINTENANCE_RUNNER_ADDRESS_POOL: "10.91.1.0/24",
    MAINTENANCE_MAINTAINER_ADDRESS_POOL: "10.91.3.0/24",
    MAINTENANCE_MACHINE_ADDRESS_POOL: "10.91.16.0/20",
    MAINTENANCE_RELAY_PEER_ID: "550e8400-e29b-41d4-a716-446655440010",
    MAINTENANCE_RELAY_ENDPOINT: `${options.hostPrivateAddress}:51820`,
    MAINTENANCE_RELAY_PUBLIC_KEY:
      "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    MAINTENANCE_RELAY_TUNNEL_ADDRESS: "10.91.0.1",
    MAINTENANCE_RELAY_CREDENTIAL:
      "local-maintenance-relay-credential-change-before-production",
    MAINTENANCE_RELAY_JWT_SECRET:
      "local-maintenance-relay-jwt-secret-change-before-production",
    MEDIA_ASSET_STORAGE_ROOT: join(
      options.stateRoot,
      "service-api-media-assets",
    ),
    PAYMENT_CONFIG_ENCRYPTION_KEY:
      "local-payment-config-encryption-key-32-chars",
  };
}

function mergeCommandEnvironment(
  explicitEnvironment,
  baseEnvironment = process.env,
) {
  const merged = {};
  for (const name of COMMAND_ENV_PASSTHROUGH) {
    const value = baseEnvironment[name];
    if (typeof value === "string" && value.length > 0) merged[name] = value;
  }
  return { ...merged, ...explicitEnvironment };
}

export function buildMigrationEnvironment(
  options,
  { baseEnvironment = process.env } = {},
) {
  return {
    ...mergeCommandEnvironment(
      buildHostLocalServiceApiEnvironment(options),
      baseEnvironment,
    ),
    DOTENV_CONFIG_PATH: join(
      options.stateRoot,
      "service-api.local-testbed.env",
    ),
  };
}

export function buildServiceApiUnitPlan(options) {
  const unit = `${SERVICE_API_UNIT}.service`;
  const environment = buildHostLocalServiceApiEnvironment(options);
  const workingDirectory = join(options.stateRoot, "service-api-runtime");
  return [
    commandLine("sudo", ["systemctl", "stop", unit]),
    commandLine("sudo", ["systemctl", "reset-failed", unit]),
    commandLine("sudo", [
      "systemd-run",
      `--unit=${SERVICE_API_UNIT}`,
      "--collect",
      "--property=Type=simple",
      "--property=Restart=no",
      "--property=StandardOutput=journal",
      "--property=StandardError=journal",
      `--property=WorkingDirectory=${workingDirectory}`,
      ...REQUIRED_SERVICE_API_ENV_KEYS.map(
        (name) => `--setenv=${name}=${environment[name]}`,
      ),
      process.execPath,
      join(options.workspace, "apps/service-api/dist/main.js"),
    ]),
  ];
}

export function buildHostControlPlaneUnitPlan(options) {
  const unit = `${HOST_CONTROL_PLANE_UNIT}.service`;
  const token = createHash("sha256")
    .update(`${options.runId}\n${options.hostPrivateAddress}\n${options.stateRoot}`)
    .digest("hex");
  return [
    commandLine("sudo", ["systemctl", "stop", unit]),
    commandLine("sudo", ["systemctl", "reset-failed", unit]),
    commandLine("sudo", [
      "systemd-run",
      `--unit=${HOST_CONTROL_PLANE_UNIT}`,
      "--collect",
      "--property=Type=simple",
      "--property=Restart=no",
      "--property=StandardOutput=journal",
      "--property=StandardError=journal",
      `--property=WorkingDirectory=${options.workspace}`,
      "--setenv=VEM_LOCAL_TESTBED_PLATFORM_DATABASE_URL=postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed",
      process.execPath,
      "scripts/testbed/host-serial-control-plane.mjs",
      "--workspace",
      options.workspace,
      "--state-root",
      options.stateRoot,
      "--bind",
      "0.0.0.0",
      "--port",
      String(HOST_CONTROL_PLANE_PORT),
      "--token",
      token,
    ]),
  ];
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(child);
      else reject(new Error(`${command} exited with ${code ?? "signal"}`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} exited with ${code ?? "signal"}: ${stderr || stdout}`,
          ),
        );
    });
  });
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await run(
        "docker",
        [
          "exec",
          SERVICE_NAMES.postgres,
          "pg_isready",
          "-U",
          "vem",
          "-d",
          "vem_local_testbed",
        ],
        { stdio: "ignore" },
      );
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  throw new Error("local testbed Postgres did not become ready");
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || payload?.code !== 0) {
    throw new Error(
      `${options.method ?? "GET"} ${path} failed: ${JSON.stringify(payload)}`,
    );
  }
  return payload.data;
}

async function waitForApi(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("local testbed Service API did not become ready");
}

async function serviceApiFailure(error) {
  let log = "log unavailable";
  try {
    const result = await runCapture("sudo", [
      "journalctl",
      "--unit",
      `${SERVICE_API_UNIT}.service`,
      "--no-pager",
      "--lines",
      "200",
      "--output",
      "short-iso-precise",
    ]);
    log = result.stdout || result.stderr || log;
  } catch {}
  return new Error(
    `${error.message}\n--- local Service API log ---\n${log.slice(-16_000)}`,
  );
}

export async function seedThroughSupportedApis({
  baseUrl,
  fixture,
  hostPrivateAddress,
  request = requestJson,
}) {
  const login = await request(baseUrl, "/auth/login", {
    method: "POST",
    body: {
      username: "local-testbed-admin",
      password: "LocalTestbedAdminPassword!",
    },
  });
  const token = login.accessToken;
  const products = [];
  for (const [index, entry] of fixture.products.entries()) {
    const product = await request(baseUrl, "/products", {
      method: "POST",
      token,
      body: {
        name: entry.name,
        description: `${entry.category} normalized testbed fixture`,
        status: "active",
        sortOrder: index,
      },
    });
    const variant = await request(baseUrl, "/product-variants", {
      method: "POST",
      token,
      body: {
        productId: product.id,
        sku: `TSC-LOCAL-${String(entry.sourceRow).padStart(3, "0")}`,
        size: entry.size,
        color: null,
        priceCents:
          fixture.slots.find((slot) => slot.sourceRow === entry.sourceRow)
            ?.priceCents ?? 5900,
        status: "active",
      },
    });
    products.push({ ...entry, product, variant });
  }
  const providers = await request(baseUrl, "/payments/providers", { token });
  const mockProvider = providers.find((provider) => provider.code === "mock");
  if (!mockProvider) {
    throw new Error("Service API test payment provider is missing");
  }
  await request(baseUrl, `/payments/providers/${mockProvider.id}`, {
    method: "PATCH",
    token,
    body: {
      status: "enabled",
    },
  });
  const machine = await request(baseUrl, "/machines", {
    method: "POST",
    token,
    body: {
      code: "VEM-TESTBED-LOCAL",
      name: "Local Windows Runtime Testbed",
      locationLabel: "testbed host",
    },
  });
  const seededSlots = [];
  for (const slot of fixture.slots) {
    const machineSlot = await request(
      baseUrl,
      `/machines/${machine.id}/slots`,
      {
        method: "POST",
        token,
        body: {
          layerNo: slot.layerNo,
          cellNo: slot.cellNo,
          slotCode: slot.slotCode,
          capacity: slot.capacity,
          status: "enabled",
        },
      },
    );
    const product = products.find((item) => item.sourceRow === slot.sourceRow);
    const inventory = await request(baseUrl, "/inventories", {
      method: "POST",
      token,
      body: {
        machineId: machine.id,
        slotId: machineSlot.id,
        variantId: product.variant.id,
        onHandQty: slot.onHandQty,
        reservedQty: 0,
        lowStockThreshold: slot.lowStockThreshold,
        note: "local testbed deterministic fixture",
      },
    });
    seededSlots.push({ slot, product, machineSlot, inventory });
  }
  const planogramVersion = "LOCAL-TESTBED-V1";
  await request(baseUrl, `/machines/${machine.id}/planogram-versions`, {
    method: "POST",
    token,
    body: {
      planogramVersion,
      slots: seededSlots.map(({ slot, product, machineSlot, inventory }) => ({
        slotId: machineSlot.id,
        slotCode: slot.slotCode,
        layerNo: slot.layerNo,
        cellNo: slot.cellNo,
        inventoryId: inventory.id,
        variantId: product.variant.id,
        productId: product.product.id,
        productName: product.name,
        productDescription: `${product.category} normalized testbed fixture`,
        coverImageUrl: null,
        categoryId: null,
        categoryName: null,
        sku: product.variant.sku,
        size: product.size,
        color: null,
        priceCents: slot.priceCents,
        productSortOrder: product.sourceRow,
        capacity: slot.capacity,
        parLevel: slot.lowStockThreshold,
      })),
    },
  });
  const claim = await request(baseUrl, `/machines/${machine.id}/claim-codes`, {
    method: "POST",
    token,
    body: { purpose: "first_claim" },
  });
  return {
    machine,
    claim,
    planogramVersion,
    apiBaseUrl: baseUrl,
    mqttUrl: `mqtt://${hostPrivateAddress}:18883`,
    slots: seededSlots.map(({ slot, inventory }) => ({
      slotCode: slot.slotCode,
      inventoryId: inventory.id,
      onHandQty: slot.onHandQty,
    })),
  };
}

async function stopServiceApiUnit(options) {
  const [stop, reset] = buildServiceApiUnitPlan(options);
  await run(stop.command, stop.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
  await run(reset.command, reset.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await runCapture("sudo", [
      "systemctl",
      "show",
      "--property=LoadState",
      "--value",
      `${SERVICE_API_UNIT}.service`,
    ]).catch(() => ({ stdout: "not-found" }));
    if (state.stdout.trim() === "not-found") return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`fixed Service API unit ${SERVICE_API_UNIT} did not unload`);
}

async function startServiceApiUnit(options) {
  const start = buildServiceApiUnitPlan(options).at(-1);
  await run(start.command, start.args, { cwd: options.workspace });
}

async function stopHostControlPlaneUnit(options) {
  const [stop, reset] = buildHostControlPlaneUnitPlan(options);
  await run(stop.command, stop.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
  await run(reset.command, reset.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
}

async function startHostControlPlaneUnit(options) {
  const start = buildHostControlPlaneUnitPlan(options).at(-1);
  await run(start.command, start.args, { cwd: options.workspace });
}

async function reconstruct(options) {
  const [contract, fixture] = await Promise.all([
    readFile(options.baselineContract, "utf8")
      .then(JSON.parse)
      .then(validateBaselineContract),
    loadFixture(),
  ]);
  await Promise.all([
    mkdir(options.stateRoot, { recursive: true }),
    mkdir(join(options.stateRoot, "service-api-runtime"), {
      recursive: true,
    }),
  ]);
  await writeFile(
    join(options.stateRoot, "mosquitto.conf"),
    "listener 1883 0.0.0.0\nallow_anonymous true\npersistence false\n",
    "utf8",
  );
  await writeFile(
    join(options.stateRoot, "service-api.local-testbed.env"),
    "",
    "utf8",
  );
  const plan = buildReconstructionPlan(options, contract);
  if (options.dryRun)
    return {
      schemaVersion: "vem-local-testbed-reconstruction/v1",
      dryRun: true,
      mode: options.mode,
      plan,
    };
  await stopServiceApiUnit(options);
  await stopHostControlPlaneUnit(options);
  await run(
    "docker",
    ["rm", "-f", SERVICE_NAMES.postgres, SERVICE_NAMES.mqtt],
    { stdio: "ignore" },
  ).catch(() => undefined);
  await run(
    "docker",
    ["volume", "rm", "-f", VOLUME_NAMES.postgres, VOLUME_NAMES.mqtt],
    { stdio: "ignore" },
  ).catch(() => undefined);
  await run(plan[2].command, plan[2].args, { cwd: options.workspace });
  for (const step of plan.slice(3, 9))
    await run(step.command, step.args, {
      cwd: options.workspace,
      env: step.env,
    });
  await waitForPostgres();
  await startServiceApiUnit(options);
  const apiBaseUrl = "http://127.0.0.1:26849/api";
  try {
    await waitForApi(apiBaseUrl);
  } catch (error) {
    throw await serviceApiFailure(error);
  }
  await startHostControlPlaneUnit(options);
  let seeded;
  try {
    seeded = await seedThroughSupportedApis({
      baseUrl: apiBaseUrl,
      fixture,
      hostPrivateAddress: options.hostPrivateAddress,
    });
  } catch (error) {
    throw await serviceApiFailure(error);
  }
  const guestInput = {
    schemaVersion: "vem-local-testbed-guest-input/v1",
    runId: options.runId,
    mode: options.mode,
    runtimeBootstrap: {
      schemaVersion: 1,
      provisioningApiBaseUrl: `http://${options.hostPrivateAddress}:26849/api`,
      hardwareModel: "vem-prod-24",
      topology: { identity: "vem-prod-24", version: "2026-06-adr0026" },
    },
    hostControlPlane: {
      endpoint: `http://${options.hostPrivateAddress}:${HOST_CONTROL_PLANE_PORT}`,
      token: createHash("sha256")
        .update(
          `${options.runId}\n${options.hostPrivateAddress}\n${options.stateRoot}`,
        )
        .digest("hex"),
      runtimeBaseIdentity: runtimeBaseIdentity(contract),
      targetIdentity: runtimeTargetIdentity(contract),
      visionMockControlPort: GUEST_VISION_MOCK_CONTROL_PORT,
    },
    claimCode: seeded.claim.claimCode,
    machineCode: seeded.machine.code,
    planogramVersion: seeded.planogramVersion,
    interactiveUser: contract.testbed.guest.user,
  };
  await writeFile(
    join(options.stateRoot, "guest-input.json"),
    `${JSON.stringify(guestInput, null, 2)}\n`,
    "utf8",
  );
  for (const step of plan.slice(9, -1))
    await run(step.command, step.args, { cwd: options.workspace });
  const admitRunner = plan.at(-1);
  await run(admitRunner.command, admitRunner.args, { cwd: options.workspace });
  const result = {
    schemaVersion: "vem-local-testbed-reconstruction/v1",
    mode: options.mode,
    runId: options.runId,
    services: SERVICE_NAMES,
    fixture: {
      source: fixture.source,
      productCount: fixture.products.length,
      slots: seeded.slots,
    },
    guestInput: {
      machineCode: seeded.machine.code,
      planogramVersion: seeded.planogramVersion,
      bootstrapPath: contract.testbed.guest.stagingPath,
    },
    runtimeTestbed: {
      hostPrivateAddress: options.hostPrivateAddress,
      platform: {
        apiBaseUrl,
        databaseUrl:
          "postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed",
      },
      hostControlPlane: {
        endpoint: `http://${options.hostPrivateAddress}:${HOST_CONTROL_PLANE_PORT}`,
        token: createHash("sha256")
          .update(
            `${options.runId}\n${options.hostPrivateAddress}\n${options.stateRoot}`,
          )
          .digest("hex"),
        targetIdentity: runtimeTargetIdentity(contract),
      },
      guest: {
        remote: `${contract.testbed.guest.user}@${contract.testbed.guest.host}`,
        host: contract.testbed.guest.host,
        user: contract.testbed.guest.user,
        identityFile: contract.testbed.guest.identityFile,
        knownHostsFile: contract.testbed.guest.knownHostsFile,
        handoffPath: GUEST_HANDOFF_PATH,
        smokePath: GUEST_SMOKE_PATH,
        visionMockControlPort: GUEST_VISION_MOCK_CONTROL_PORT,
      },
      runtimeBaseIdentity: runtimeBaseIdentity(contract),
      targetIdentity: runtimeTargetIdentity(contract),
    },
  };
  await writeFile(
    join(options.stateRoot, "reconstruction.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await reconstruct(options);
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
