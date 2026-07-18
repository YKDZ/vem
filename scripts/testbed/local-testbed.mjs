#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
const MODES = new Set(["fast", "full", "clear_cache"]);

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

export function parseOptions(args) {
  const command = args[0];
  if (command !== "reconstruct") {
    throw new Error(
      "usage: local-testbed.mjs reconstruct --mode fast|full|clear_cache ...",
    );
  }
  const mode = option(args, "mode");
  if (!MODES.has(mode))
    throw new Error("--mode must be fast, full, or clear_cache");
  const hostPrivateAddress = option(args, "host-private-address");
  if (isIP(hostPrivateAddress) !== 4 || hostPrivateAddress.startsWith("127.")) {
    throw new Error(
      "--host-private-address must be a non-loopback IPv4 address",
    );
  }
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
  if (
    !contract.artifacts?.systemPath ||
    !contract.artifacts?.cachePath ||
    !contract.testbed
  ) {
    throw new Error(
      "published baseline contract must include artifacts and the Issue 14 testbed binding",
    );
  }
  const binding = contract.testbed;
  if (
    !Array.isArray(binding.reconstructCommand) ||
    binding.reconstructCommand.length < 1
  ) {
    throw new Error(
      "baseline testbed binding reconstructCommand must be a command array",
    );
  }
  if (
    !Array.isArray(binding.admitRunnerCommand) ||
    binding.admitRunnerCommand.length < 1
  ) {
    throw new Error(
      "baseline contract admitRunnerCommand must be a command array",
    );
  }
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
  if (
    !isAbsolute(binding.guest.identityFile) ||
    !isAbsolute(binding.guest.knownHostsFile)
  ) {
    throw new Error("baseline contract SSH files must be absolute");
  }
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

function commandLine(command, args) {
  return { command, args: args.map(String) };
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
    commandLine(
      binding.reconstructCommand[0],
      binding.reconstructCommand
        .slice(1)
        .map((part) => part.replaceAll("{runId}", options.runId)),
    ),
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
    commandLine("pnpm", ["--filter", "@vem/db", "migrate"]),
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
    commandLine(
      binding.admitRunnerCommand[0],
      binding.admitRunnerCommand
        .slice(1)
        .map((part) => part.replaceAll("{runId}", options.runId)),
    ),
  ];
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
      detached: options.detached ?? false,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(child);
      else reject(new Error(`${command} exited with ${code ?? "signal"}`));
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

async function serviceApiFailure(stateRoot, error) {
  const logPath = join(stateRoot, "service-api.log");
  let log = "log unavailable";
  try {
    log = await readFile(logPath, "utf8");
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
      capabilities: {
        createPaymentIntent: true,
        paymentCode: true,
        webhook: true,
        refund: true,
      },
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

async function startServiceApi(options) {
  const logPath = join(options.stateRoot, "service-api.log");
  const pidPath = join(options.stateRoot, "service-api.pid");
  await Promise.all([
    rm(pidPath, { force: true }),
    rm(logPath, { force: true }),
  ]);
  const child = spawn("node", ["apps/service-api/dist/main.js"], {
    cwd: options.workspace,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL:
        "postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed",
      MQTT_URL: "mqtt://127.0.0.1:18883",
      MACHINE_MQTT_URL: `mqtt://${options.hostPrivateAddress}:18883`,
      MACHINE_API_BASE_URL: `http://${options.hostPrivateAddress}:26849/api`,
      PAYMENT_WEBHOOK_BASE_URL: "http://127.0.0.1:26849",
      PAYMENT_MOCK_ENABLED: "true",
      SERVICE_HOST: "0.0.0.0",
      SERVICE_PORT: "26849",
      BOOTSTRAP_ADMIN_USERNAME: "local-testbed-admin",
      BOOTSTRAP_ADMIN_PASSWORD: "LocalTestbedAdminPassword!",
      JWT_SECRET: "local-testbed-jwt-secret-at-least-32-characters",
      JWT_REFRESH_SECRET: "local-testbed-refresh-secret-at-least-32-characters",
      MACHINE_JWT_SECRET: "local-testbed-machine-jwt-secret-at-least-32-chars",
      MACHINE_CREDENTIAL_ENCRYPTION_KEY:
        "local-testbed-machine-credential-key-32-chars",
      MACHINE_CLAIM_LOOKUP_HMAC_KEY:
        "local-testbed-machine-claim-lookup-key-v1",
    },
  });
  child.stdout.pipe(
    (await import("node:fs")).createWriteStream(logPath, { flags: "a" }),
  );
  child.stderr.pipe(
    (await import("node:fs")).createWriteStream(logPath, { flags: "a" }),
  );
  child.unref();
  await writeFile(pidPath, `${child.pid}\n`, "utf8");
}

async function replacePriorServiceApi(stateRoot) {
  const pidPath = join(stateRoot, "service-api.pid");
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 1) {
      process.kill(pid, "SIGTERM");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, 100),
          );
        } catch {
          break;
        }
        if (attempt === 49) process.kill(pid, "SIGKILL");
      }
    }
  } catch {}
  await rm(pidPath, { force: true });
}

async function reconstruct(options) {
  const [contract, fixture] = await Promise.all([
    readFile(options.baselineContract, "utf8")
      .then(JSON.parse)
      .then(validateBaselineContract),
    loadFixture(),
  ]);
  await mkdir(options.stateRoot, { recursive: true });
  await writeFile(
    join(options.stateRoot, "mosquitto.conf"),
    "listener 1883 0.0.0.0\nallow_anonymous true\npersistence false\n",
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
  await replacePriorServiceApi(options.stateRoot);
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
    await run(step.command, step.args, { cwd: options.workspace });
  await waitForPostgres();
  await startServiceApi(options);
  const apiBaseUrl = "http://127.0.0.1:26849/api";
  try {
    await waitForApi(apiBaseUrl);
  } catch (error) {
    throw await serviceApiFailure(options.stateRoot, error);
  }
  let seeded;
  try {
    seeded = await seedThroughSupportedApis({
      baseUrl: apiBaseUrl,
      fixture,
      hostPrivateAddress: options.hostPrivateAddress,
    });
  } catch (error) {
    throw await serviceApiFailure(options.stateRoot, error);
  }
  const guestInput = {
    schemaVersion: "vem-local-testbed-guest-input/v1",
    mode: options.mode,
    runtimeBootstrap: {
      schemaVersion: 1,
      provisioningApiBaseUrl: `http://${options.hostPrivateAddress}:26849/api`,
      hardwareModel: "vem-prod-24",
      topology: { identity: "vem-prod-24", version: "2026-06-adr0026" },
    },
    claimCode: seeded.claim.claimCode,
    machineCode: seeded.machine.code,
    planogramVersion: seeded.planogramVersion,
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
  return {
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
  };
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
