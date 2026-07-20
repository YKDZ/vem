#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { allocateFullWorkflowFixtures } from "./full-workflow-fixtures.mjs";
import { paymentMockCreateGatePaths } from "./mock-payment-create-gate.mjs";

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
const HEADLESS_VNC_ACTIVATOR_UNIT = "vem-local-testbed-headless-vnc-activator";
const GUEST_HANDOFF_PATH =
  "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json";
const GUEST_SMOKE_PATH =
  "C:\\ProgramData\\VEM\\testbed\\installed-runtime-smoke.json";
const GUEST_VISION_MOCK_CONTROL_PORT = 7893;
const HOST_CONTROL_PLANE_PORT = 26851;
const MODES = new Set(["fast", "full", "clear_cache"]);
const RETAINED_CACHE_CONTRACT = Object.freeze([
  "D:\\runtime-cache\\v1\\pnpm-store",
  "D:\\runtime-cache\\v1\\pnpm-virtual-store",
  "D:\\runtime-cache\\v1\\cargo-home",
  "D:\\runtime-cache\\v1\\target",
  "D:\\runtime-cache\\v1\\sccache",
  "D:\\runtime-cache\\v1\\turbo",
  "D:\\runtime-cache\\v1\\vision-main",
  "D:\\runtime-cache\\v1\\powershell",
]);
const REQUIRED_SERVICE_API_ENV_KEYS = Object.freeze([
  "NODE_ENV",
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "MACHINE_JWT_SECRET",
  "MACHINE_CREDENTIAL_ENCRYPTION_KEY",
  "MACHINE_CLAIM_LOOKUP_HMAC_KEY",
  "MACHINE_CLAIM_CODE_TTL_SECONDS",
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
  "PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH",
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
const SERVICE_API_LOG_TAIL_MAX_CHARS = 16_000;
const HOST_SIMULATOR_CACHE_DIRECTORY = "host-lower-controller-sim";
const LOWER_CONTROLLER_SIM_CACHE_DIRECTORY_NAME = /^[a-f0-9]{64}$/;
const LOWER_CONTROLLER_SIM_SOURCE_PATHS = Object.freeze([
  "Cargo.lock",
  "Cargo.toml",
  "apps/lower-controller-sim/Cargo.toml",
  "crates/vending-core/Cargo.toml",
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
    binding.admitGuestCommand,
    "admit",
    "baseline contract testbed.admitGuestCommand",
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
  if (binding.guest.user !== "VEMKiosk") {
    throw new Error(
      "baseline contract guest.user must be the production machine user VEMKiosk",
    );
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

function baselineContractDigest(contract) {
  return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
}

function workflowIdentity(options, contract) {
  const baselineDigest = baselineContractDigest(contract);
  const runtimeBase = runtimeBaseIdentity(contract);
  return {
    githubSha: process.env.GITHUB_SHA ?? null,
    baseline: { releaseId: contract.releaseId, digest: baselineDigest },
    runtimeBase,
    reconstructionId: `reconstruction://sha256/${createHash("sha256")
      .update(`${options.runId}\n${baselineDigest}\n${runtimeBase}`)
      .digest("hex")}`,
    retainedCaches: [...RETAINED_CACHE_CONTRACT],
    observedRetainedCaches: null,
    removedUndeclaredCaches: [],
  };
}

function parseJsonLine(stdout, label) {
  const trimmed = String(stdout ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} did not emit JSON`);
  }
  const lastLine = trimmed.split(/\r?\n/).at(-1);
  try {
    return JSON.parse(lastLine);
  } catch {
    throw new Error(`${label} emitted malformed JSON`);
  }
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
    (() => {
      const guestAdmission = renderPublishedCommand(
        binding.admitGuestCommand,
        options,
        contract,
      );
      return commandLine(guestAdmission.command, [...guestAdmission.args]);
    })(),
  ];
}

async function sourceFilesUnder(root, relativeDirectory, listDirectory) {
  const directory = join(root, relativeDirectory);
  const entries = await listDirectory(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await sourceFilesUnder(root, relativePath, listDirectory)),
      );
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function lowerControllerSimSourceFingerprint(
  workspace,
  { listDirectory = readdir, readSource = readFile } = {},
) {
  const root = absolute(workspace, "workspace");
  const sourceFiles = [
    ...LOWER_CONTROLLER_SIM_SOURCE_PATHS,
    ...(await sourceFilesUnder(
      root,
      "apps/lower-controller-sim/src",
      listDirectory,
    )),
    ...(await sourceFilesUnder(root, "crates/vending-core/src", listDirectory)),
  ].sort();
  const digest = createHash("sha256");
  for (const relativePath of sourceFiles) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(await readSource(join(root, relativePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function lowerControllerSimCacheLayout(options, sourceDigest) {
  if (!/^[a-f0-9]{64}$/.test(sourceDigest ?? "")) {
    throw new Error(
      "lower-controller simulator source digest must be a SHA-256 hex string",
    );
  }
  const root = join(
    absolute(options.stateRoot, "stateRoot"),
    HOST_SIMULATOR_CACHE_DIRECTORY,
    sourceDigest,
  );
  const targetDirectory = join(root, "target");
  return {
    sourceDigest,
    root,
    targetDirectory,
    binaryPath: join(targetDirectory, "debug", "lower-controller-sim"),
    successMarkerPath: join(root, "build-success.json"),
  };
}

function isValidCacheDigest(value) {
  return LOWER_CONTROLLER_SIM_CACHE_DIRECTORY_NAME.test(value);
}

async function removeOutdatedLowerControllerSimCaches({
  layout,
  stateRoot,
  listDirectory = readdir,
  removeDirectory = rm,
}) {
  const cacheRoot = join(
    absolute(stateRoot, "stateRoot"),
    HOST_SIMULATOR_CACHE_DIRECTORY,
  );
  try {
    await access(cacheRoot, constants.F_OK);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const entries = await listDirectory(cacheRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    if (
      !entry.isDirectory() ||
      !isValidCacheDigest(entry.name) ||
      entry.name === layout.sourceDigest
    ) {
      continue;
    }
    await removeDirectory(join(cacheRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

export async function ensureLowerControllerSimCached({
  options,
  sourceDigest,
  dependencies = {},
}) {
  const resolvedSourceDigest =
    sourceDigest ??
    (await lowerControllerSimSourceFingerprint(
      options.workspace,
      dependencies,
    ));
  const layout = lowerControllerSimCacheLayout(options, resolvedSourceDigest);
  const isExecutable =
    dependencies.isExecutable ??
    (async (path) =>
      access(path, constants.X_OK)
        .then(() => true)
        .catch(() => false));
  const markerPresent =
    dependencies.markerPresent ??
    (async (path) =>
      access(path, constants.R_OK)
        .then(() => true)
        .catch(() => false));
  const pruneOldCaches = async () =>
    removeOutdatedLowerControllerSimCaches({
      layout,
      stateRoot: options.stateRoot,
      listDirectory: dependencies.listDirectory ?? readdir,
      removeDirectory: dependencies.removeDirectory ?? rm,
    });
  if (
    (await isExecutable(layout.binaryPath)) &&
    (await markerPresent(layout.successMarkerPath))
  ) {
    await pruneOldCaches();
    return { ...layout, cache: "hit" };
  }
  const ensureDirectory = dependencies.ensureDirectory ?? mkdir;
  const runCommand = dependencies.runCommand ?? run;
  await ensureDirectory(layout.targetDirectory, { recursive: true });
  await runCommand(
    "cargo",
    ["build", "-p", "lower-controller-sim", "--locked"],
    {
      cwd: options.workspace,
      env: { ...process.env, CARGO_TARGET_DIR: layout.targetDirectory },
    },
  );
  if (!(await isExecutable(layout.binaryPath))) {
    throw new Error(
      "lower-controller simulator build did not publish an executable to its persistent cache",
    );
  }
  const publishMarker = dependencies.publishMarker ?? writeFile;
  await publishMarker(
    layout.successMarkerPath,
    `${JSON.stringify({ sourceDigest: resolvedSourceDigest })}\n`,
    "utf8",
  );
  await pruneOldCaches();
  return { ...layout, cache: "miss" };
}

export function buildHostLocalServiceApiEnvironment(options) {
  const createOrderGate = paymentMockCreateGatePaths(options.stateRoot);
  return {
    NODE_ENV: "development",
    DATABASE_URL:
      "postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed",
    MQTT_URL: "mqtt://127.0.0.1:18883",
    MACHINE_MQTT_URL: `mqtt://${options.hostPrivateAddress}:18883`,
    MACHINE_API_BASE_URL: `http://${options.hostPrivateAddress}:26849/api`,
    PAYMENT_WEBHOOK_BASE_URL: `http://${options.hostPrivateAddress}:26849`,
    PAYMENT_MOCK_ENABLED: "true",
    PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH: createOrderGate.statePath,
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
    MACHINE_CLAIM_CODE_TTL_SECONDS: "7200",
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

export { paymentMockCreateGatePaths } from "./mock-payment-create-gate.mjs";

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

function baselineDomainName(contract) {
  const command = contract?.testbed?.reconstructCommand;
  const index = Array.isArray(command) ? command.indexOf("--domain-name") : -1;
  return required(
    index >= 0 ? command[index + 1] : null,
    "baseline domain name",
  );
}

export function buildHostControlPlaneUnitPlan(
  options,
  contract,
  {
    lowerControllerSimPath = join(
      options.workspace,
      "target/debug/lower-controller-sim",
    ),
  } = {},
) {
  const unit = `${HOST_CONTROL_PLANE_UNIT}.service`;
  const token = createHash("sha256")
    .update(
      `${options.runId}\n${options.hostPrivateAddress}\n${options.stateRoot}`,
    )
    .digest("hex");
  const adapterPath = join(
    options.workspace,
    "scripts/testbed/qemu-usb-serial-host-adapter.mjs",
  );
  const adapterDigest = createHash("sha256")
    .update(readFileSync(adapterPath))
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
      `--setenv=VEM_VM_HOST_ADAPTER=${adapterPath}`,
      "--setenv=VEM_VM_HOST_ADAPTER_VERSION=1.0.0",
      `--setenv=VEM_VM_HOST_ADAPTER_SHA256=sha256:${adapterDigest}`,
      `--setenv=VEM_VM_HOST_ADAPTER_DOMAIN=${baselineDomainName(contract)}`,
      `--setenv=VEM_VM_HOST_ADAPTER_STATE_ROOT=${join(options.stateRoot, "host-adapter")}`,
      `--setenv=VEM_LOWER_CONTROLLER_SIM=${lowerControllerSimPath}`,
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
      "--libvirt-uri",
      baselineLibvirtUri(contract),
      "--domain-name",
      baselineDomainName(contract),
    ]),
  ];
}

function baselineLibvirtUri(contract) {
  const command = contract?.testbed?.reconstructCommand;
  const index = Array.isArray(command) ? command.indexOf("--libvirt-uri") : -1;
  return required(
    index >= 0 ? command[index + 1] : null,
    "baseline libvirt uri",
  );
}

export function buildHeadlessVncActivatorUnitPlan(options, contract) {
  const unit = `${HEADLESS_VNC_ACTIVATOR_UNIT}.service`;
  return [
    commandLine("sudo", ["systemctl", "stop", unit]),
    commandLine("sudo", ["systemctl", "reset-failed", unit]),
    commandLine("sudo", [
      "systemd-run",
      `--unit=${HEADLESS_VNC_ACTIVATOR_UNIT}`,
      "--collect",
      "--property=Type=simple",
      "--property=Restart=no",
      "--property=StandardOutput=journal",
      "--property=StandardError=journal",
      `--property=WorkingDirectory=${options.workspace}`,
      process.execPath,
      join(options.workspace, "scripts/testbed/local-testbed-host.mjs"),
      "headless-vnc-activator",
      "--libvirt-uri",
      baselineLibvirtUri(contract),
      "--domain-name",
      baselineDomainName(contract),
      "--state-root",
      options.stateRoot,
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

export function interpretServiceApiJournalCapture(input) {
  if (input.ok === true) {
    const stdout = String(input.stdout ?? "");
    if (stdout.length === 0) {
      return {
        kind: "unavailable",
        text: "journalctl returned no stdout",
      };
    }
    return {
      kind: "journal",
      text: stdout.slice(-SERVICE_API_LOG_TAIL_MAX_CHARS),
    };
  }
  return {
    kind: "unavailable",
    text: String(input.error ?? "journalctl failed").slice(
      -SERVICE_API_LOG_TAIL_MAX_CHARS,
    ),
  };
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

const TESTBED_TRY_ON_SILHOUETTE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAACACAYAAABMXPacAAAAlUlEQVR4nO3QQREAIAzAsIF/z0NGHjQKej07s/OxqwO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAeUzUCf0J2cKoAAAAASUVORK5CYII=";

function testbedTryOnSilhouetteAsset() {
  return {
    fileName: "local-testbed-try-on-silhouette.png",
    contentType: "image/png",
    buffer: Buffer.from(TESTBED_TRY_ON_SILHOUETTE_PNG_BASE64, "base64"),
  };
}

function supportsTryOnAcceptance(entry) {
  return entry.category === "T恤";
}

async function uploadMultipartFile(baseUrl, path, options) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([options.buffer], { type: options.contentType }),
    options.fileName,
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: form,
  });
  const payload = await response.json();
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`POST ${path} failed: ${JSON.stringify(payload)}`);
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
  let journal = { kind: "unavailable", text: "journalctl was not attempted" };
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
    journal = interpretServiceApiJournalCapture({
      ok: true,
      stdout: result.stdout,
    });
  } catch (journalError) {
    journal = interpretServiceApiJournalCapture({
      ok: false,
      error:
        journalError instanceof Error
          ? journalError.message
          : String(journalError),
    });
  }
  const suffix =
    journal.kind === "journal"
      ? `--- local Service API log ---\n${journal.text}`
      : `--- local Service API log unavailable ---\n${journal.text}`;
  return new Error(`${error.message}\n${suffix}`);
}

export async function seedThroughSupportedApis({
  baseUrl,
  fixture,
  hostPrivateAddress,
  request = requestJson,
  upload = uploadMultipartFile,
}) {
  const login = await request(baseUrl, "/auth/login", {
    method: "POST",
    body: {
      username: "local-testbed-admin",
      password: "LocalTestbedAdminPassword!",
    },
  });
  const token = login.accessToken;
  const tryOnSilhouetteAsset = await upload(
    baseUrl,
    "/media-assets/try-on-silhouettes",
    {
      token,
      ...testbedTryOnSilhouetteAsset(),
    },
  );
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
        tryOnSilhouetteMediaAssetId: supportsTryOnAcceptance(entry)
          ? tryOnSilhouetteAsset.id
          : null,
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
  await request(baseUrl, `/machines/${machine.id}`, {
    method: "PATCH",
    token,
    body: { status: "online" },
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
  const seededTryOnVariants = products
    .filter((entry) => supportsTryOnAcceptance(entry))
    .map((entry) => ({
      sourceRow: entry.sourceRow,
      productId: entry.product.id,
      variantId: entry.variant.id,
      sku: entry.variant.sku,
      size: entry.size,
      silhouetteAssetId: tryOnSilhouetteAsset.id,
      silhouettePublicUrl: tryOnSilhouetteAsset.publicUrl,
    }));
  return {
    machine,
    claim,
    planogramVersion,
    apiBaseUrl: baseUrl,
    mqttUrl: `mqtt://${hostPrivateAddress}:18883`,
    visionAcceptance: {
      tryOnSilhouetteAssetId: tryOnSilhouetteAsset.id,
      tryOnSilhouettePublicUrl: tryOnSilhouetteAsset.publicUrl,
      tryOnCategoryKey: "tshirts",
      seededTryOnVariants,
    },
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

async function stopHostControlPlaneUnit(options, contract) {
  const [stop, reset] = buildHostControlPlaneUnitPlan(options, contract);
  await run(stop.command, stop.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
  await run(reset.command, reset.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
}

async function startHostControlPlaneUnit(
  options,
  contract,
  lowerControllerSimPath,
) {
  const start = buildHostControlPlaneUnitPlan(options, contract, {
    lowerControllerSimPath,
  }).at(-1);
  await run(start.command, start.args, { cwd: options.workspace });
}

async function stopHeadlessVncActivatorUnit(options, contract) {
  const [stop, reset] = buildHeadlessVncActivatorUnitPlan(options, contract);
  await run(stop.command, stop.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
  await run(reset.command, reset.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
}

async function startHeadlessVncActivatorUnit(options, contract) {
  const start = buildHeadlessVncActivatorUnitPlan(options, contract).at(-1);
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
  const createOrderGate = paymentMockCreateGatePaths(options.stateRoot);
  await mkdir(dirname(createOrderGate.statePath), { recursive: true });
  await writeFile(
    createOrderGate.statePath,
    `${JSON.stringify({ state: "open" })}\n`,
    "utf8",
  );
  const plan = buildReconstructionPlan(options, contract);
  const identity = workflowIdentity(options, contract);
  if (options.dryRun)
    return {
      schemaVersion: "vem-local-testbed-reconstruction/v1",
      dryRun: true,
      mode: options.mode,
      workflowIdentity: identity,
      plan,
    };
  await stopServiceApiUnit(options);
  await stopHostControlPlaneUnit(options, contract);
  await stopHeadlessVncActivatorUnit(options, contract);
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
  try {
    const hostSimulator = await ensureLowerControllerSimCached({ options });
    const reconstructionStartedAt = new Date().toISOString();
    const reconstructHost = await runCapture(plan[2].command, plan[2].args, {
      cwd: options.workspace,
    });
    const reconstructionFinishedAt = new Date().toISOString();
    const reconstructHostResult = parseJsonLine(
      reconstructHost.stdout,
      "host reconstruction",
    );
    await startHeadlessVncActivatorUnit(options, contract);
    for (const step of plan.slice(3, 7))
      await run(step.command, step.args, {
        cwd: options.workspace,
        env: step.env,
      });
    await waitForPostgres();
    for (const step of plan.slice(7, 9))
      await run(step.command, step.args, {
        cwd: options.workspace,
        env: step.env,
      });
    await startServiceApiUnit(options);
    const apiBaseUrl = "http://127.0.0.1:26849/api";
    try {
      await waitForApi(apiBaseUrl);
    } catch (error) {
      throw await serviceApiFailure(error);
    }
    await startHostControlPlaneUnit(
      options,
      contract,
      hostSimulator.binaryPath,
    );
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
      workflowIdentity: identity,
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
      fastSale: {
        paymentOptionKey: "mock:mock",
      },
      fixtureAllocation: allocateFullWorkflowFixtures(seeded.slots),
      claimCode: seeded.claim.claimCode,
      machineCode: seeded.machine.code,
      planogramVersion: seeded.planogramVersion,
      interactiveUser: "VEMKiosk",
      visionAcceptance: seeded.visionAcceptance,
    };
    await writeFile(
      join(options.stateRoot, "guest-input.json"),
      `${JSON.stringify(guestInput, null, 2)}\n`,
      "utf8",
    );
    for (const step of plan.slice(9, -1))
      await run(step.command, step.args, { cwd: options.workspace });
    const admitGuest = plan.at(-1);
    const admissionStartedAt = new Date().toISOString();
    const admitHost = await runCapture(admitGuest.command, admitGuest.args, {
      cwd: options.workspace,
    });
    const admissionFinishedAt = new Date().toISOString();
    const admitHostResult = parseJsonLine(admitHost.stdout, "host admission");
    const result = {
      schemaVersion: "vem-local-testbed-reconstruction/v1",
      mode: options.mode,
      runId: options.runId,
      workflowIdentity: identity,
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
        hostSimulator: {
          cache: hostSimulator.cache,
          sourceDigest: hostSimulator.sourceDigest,
          binaryPath: hostSimulator.binaryPath,
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
        displayLifecycle: {
          headlessVncActivatorUnit: `${HEADLESS_VNC_ACTIVATOR_UNIT}.service`,
          reconstruct: {
            ...reconstructHostResult,
            startedAt: reconstructionStartedAt,
            finishedAt: reconstructionFinishedAt,
            durationMs:
              Date.parse(reconstructionFinishedAt) -
              Date.parse(reconstructionStartedAt),
          },
          admission: {
            ...admitHostResult,
            startedAt: admissionStartedAt,
            finishedAt: admissionFinishedAt,
            durationMs:
              Date.parse(admissionFinishedAt) - Date.parse(admissionStartedAt),
          },
        },
      },
    };
    await writeFile(
      join(options.stateRoot, "reconstruction.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    return result;
  } catch (error) {
    await stopHeadlessVncActivatorUnit(options, contract).catch(
      () => undefined,
    );
    throw error;
  }
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
