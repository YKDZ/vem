#!/usr/bin/env node

import { topCategoryKeyForCatalogItem } from "@vem/shared/catalog-top-category";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import { allocateFullWorkflowFixtures } from "./full-workflow-fixtures.ts";
import {
  paymentMockCreateGatePaths,
  paymentMockQueryFaultPaths,
  writePaymentMockQueryFaultState,
} from "./mock-payment-create-gate.ts";
import { validateInstallationOwnedAlipaySandboxFixture } from "./payment-provider-guest-full.ts";

const FIXTURE_PATH = new URL(
  "./fixtures/local-testbed-catalog.json",
  import.meta.url,
);
const SERVICE_NAMES = Object.freeze({
  postgres: "vem-local-testbed-postgres",
  mqtt: "vem-local-testbed-mosquitto",
});
const BACKEND_COMPOSE_PROJECT = "vem-local-testbed";
const SERVICE_API_SOURCE_IMAGE = "node:24-bookworm-slim";
const SERVICE_API_CONTAINER_WORKSPACE = "/workspace";
const SERVICE_API_CONTAINER_STATE_ROOT = "/testbed-state";
const LOCAL_TESTBED_POSTGRES_DB = "vem_local_testbed";
const LOCAL_TESTBED_POSTGRES_USER = "vem";
const LOCAL_TESTBED_POSTGRES_PASSWORD = "vem_local_testbed_password";
const LOCAL_TESTBED_MQTT_USERNAME = "vem_local_testbed_mqtt";
const LOCAL_TESTBED_MQTT_PASSWORD = "vem_local_testbed_mqtt_password";
const VOLUME_NAMES = Object.freeze({
  postgres: "vem-local-testbed-postgres-data",
  mqtt: "vem-local-testbed-mosquitto-data",
});
const HOST_CONTROL_PLANE_UNIT = "vem-local-testbed-host-control-plane";
const HEADLESS_VNC_ACTIVATOR_UNIT = "vem-local-testbed-headless-vnc-activator";
const GUEST_HANDOFF_PATH =
  "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json";
const GUEST_SMOKE_PATH =
  "C:\\ProgramData\\VEM\\testbed\\installed-runtime-smoke.json";
const GUEST_VISION_MOCK_CONTROL_PORT = 7893;
const HOST_CONTROL_PLANE_PORT = 26851;
const LOCAL_TESTBED_ADMIN_USERNAME = "local-testbed-admin";
const LOCAL_TESTBED_ADMIN_PASSWORD = "LocalTestbedAdminPassword!";
const MODES = new Set(["fast", "full", "clear_cache"]);
const RETAINED_CACHE_CONTRACT = Object.freeze([
  "D:\\runtime-cache\\v1\\pnpm-store",
  "D:\\runtime-cache\\v1\\pnpm-virtual-store",
  "D:\\runtime-cache\\v1\\cargo-home",
  "D:\\runtime-cache\\v1\\target",
  "D:\\runtime-cache\\v1\\sccache",
  "D:\\runtime-cache\\v1\\turbo",
  "D:\\runtime-cache\\v1\\vision-main",
  "D:\\runtime-cache\\v1\\acceptance-inputs",
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
  "MQTT_USERNAME",
  "MQTT_PASSWORD",
  "PAYMENT_MOCK_ENABLED",
  "PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH",
  "PAYMENT_MOCK_PROVIDER_QUERY_FAULT_PATH",
  "PAYMENT_WEBHOOK_BASE_URL",
  "MACHINE_API_BASE_URL",
  "MEDIA_ASSET_STORAGE_ROOT",
  "PAYMENT_CONFIG_ENCRYPTION_KEY",
  "BOOTSTRAP_ADMIN_USERNAME",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "SERVICE_HOST",
  "SERVICE_PORT",
]);

export function categoryKeyForFixtureProduct(product) {
  return (
    topCategoryKeyForCatalogItem({
      categoryName: product?.category ?? null,
      productName: product?.name ?? null,
    }) ?? "other"
  );
}
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
const VISION_RECOMMENDATION_VARIANTS = Object.freeze([
  { size: "M", rowNo: 2, cellNo: 4 },
  { size: "S", rowNo: 2, cellNo: 3 },
]);
const VISION_RECOMMENDATION_BASE_SOURCE_ROW = 32;
const VISION_RECOMMENDATION_UNMATCHED_SOURCE_ROW = 2;
const HOST_SIMULATOR_CACHE_DIRECTORY = "host-lower-controller-sim";
const INSTALLATION_ALIPAY_SANDBOX_FIXTURE_ENV =
  "VEM_LOCAL_TESTBED_ALIPAY_SANDBOX_FIXTURE";
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
    command[1] !== "{repository}/scripts/testbed/local-testbed-host.ts" ||
    command[2] !== action
  ) {
    throw new Error(
      `${label} must invoke the tracked local-testbed-host.ts ${action} action`,
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

export function validateHostPrivateAddress(hostPrivateAddress) {
  if (isIP(hostPrivateAddress) !== 4 || hostPrivateAddress.startsWith("127.")) {
    throw new Error(
      "--host-private-address must be a non-loopback IPv4 address",
    );
  }
  return hostPrivateAddress;
}

export function parseOptions(args) {
  const command = args[0];
  if (!new Set(["reconstruct", "refresh-host-runtime"]).has(command)) {
    throw new Error(
      "usage: local-testbed.ts reconstruct|refresh-host-runtime ...",
    );
  }
  const hostPrivateAddress = validateHostPrivateAddress(
    option(args, "host-private-address"),
  );
  const common = {
    command,
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
  if (command === "refresh-host-runtime") {
    return {
      ...common,
      runId: required(option(args, "run-id"), "--run-id"),
    };
  }
  const mode = option(args, "mode");
  if (!MODES.has(mode))
    throw new Error("--mode must be fast, full, or clear_cache");
  return {
    ...common,
    mode,
    runId: required(option(args, "run-id"), "--run-id"),
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

function baselineInteractiveUserPasswordPath(contract) {
  const guest = contract.testbed.guest;
  const passwordPath =
    guest.interactiveUserPasswordFile ??
    guest.administratorPasswordFile ??
    join(dirname(guest.identityFile), "administrator-password");
  if (!isAbsolute(passwordPath)) {
    throw new Error(
      "baseline contract guest interactive user password file must be absolute",
    );
  }
  return passwordPath;
}

async function readBaselineInteractiveUserPassword(contract) {
  const password = (
    await readFile(baselineInteractiveUserPasswordPath(contract), "utf8")
  ).replace(/\r?\n$/, "");
  if (password.length === 0) {
    throw new Error("baseline interactive user password file is empty");
  }
  return password;
}

async function loadFixture() {
  return (await loadFixtureDocument()).fixture;
}

function fixtureIdentityFromRaw(raw) {
  const seedSource = readFileSync(
    new URL("./local-testbed.ts", import.meta.url),
  );
  return {
    schemaVersion: "vem-local-testbed-fixture/v1",
    sha256: `sha256:${createHash("sha256")
      .update(raw)
      .update("\0")
      .update(seedSource)
      .digest("hex")}`,
  };
}

async function loadFixtureDocument() {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw);
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
  return { fixture, identity: fixtureIdentityFromRaw(raw) };
}

function commandLine(command, args, extra = {}) {
  return { command, args: args.map(String), ...extra };
}

function renderNodeExecutable(command) {
  if (!["node", "nodejs"].includes(basename(command))) return command;
  if (!isAbsolute(command) || existsSync(command)) return command;
  return process.execPath;
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
  return commandLine(renderNodeExecutable(rendered[0]), rendered.slice(1));
}

function backendComposeFile(options) {
  return join(options.workspace, "apps/service-api/docker-compose.yml");
}

function backendComposeEnvFile(options) {
  return join(options.stateRoot, "backend.compose.env");
}

function backendComposeOverrideFile(options) {
  return join(options.stateRoot, "backend.compose.override.yml");
}

function quoteComposeEnv(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

export function buildBackendComposeEnvironment(options) {
  return {
    POSTGRES_DB: LOCAL_TESTBED_POSTGRES_DB,
    POSTGRES_USER: LOCAL_TESTBED_POSTGRES_USER,
    POSTGRES_PASSWORD: LOCAL_TESTBED_POSTGRES_PASSWORD,
    POSTGRES_IMAGE: "postgres:16",
    POSTGRES_DATA_SOURCE: VOLUME_NAMES.postgres,
    MQTT_IMAGE: "eclipse-mosquitto:2",
    MQTT_USERNAME: LOCAL_TESTBED_MQTT_USERNAME,
    MQTT_PASSWORD: LOCAL_TESTBED_MQTT_PASSWORD,
    MQTT_PORT: "18883",
    MQTT_DATA_SOURCE: VOLUME_NAMES.mqtt,
    SERVICE_API_IMAGE: "ghcr.io/ykdz/vem-service-api:local-testbed-unused",
    ADMIN_UI_IMAGE: "ghcr.io/ykdz/vem-admin-ui:local-testbed-unused",
    SERVICE_API_PORT: "26849",
    ADMIN_UI_PORT: "26850",
    JWT_SECRET: "local-testbed-jwt-secret-at-least-32-characters",
    JWT_REFRESH_SECRET: "local-testbed-refresh-secret-at-least-32-characters",
    BOOTSTRAP_ADMIN_PASSWORD: LOCAL_TESTBED_ADMIN_PASSWORD,
    MACHINE_JWT_SECRET: "local-testbed-machine-jwt-secret-at-least-32-chars",
    MACHINE_CREDENTIAL_ENCRYPTION_KEY:
      "local-testbed-machine-credential-key-32-chars",
    MACHINE_CLAIM_LOOKUP_HMAC_KEY: "local-testbed-machine-claim-lookup-key-v1",
    PAYMENT_WEBHOOK_BASE_URL: `http://${options.hostPrivateAddress}:26849`,
    PAYMENT_CONFIG_ENCRYPTION_KEY:
      "local-payment-config-encryption-key-32-chars",
  };
}

function containerStatePath(...parts) {
  return [SERVICE_API_CONTAINER_STATE_ROOT, ...parts].join("/");
}

export function buildComposeServiceApiEnvironment(options) {
  return {
    ...buildHostLocalServiceApiEnvironment(options),
    DATABASE_URL: `postgresql://${LOCAL_TESTBED_POSTGRES_USER}:${LOCAL_TESTBED_POSTGRES_PASSWORD}@postgres:5432/${LOCAL_TESTBED_POSTGRES_DB}`,
    MQTT_URL: "mqtt://mqtt:1883",
    PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH: containerStatePath(
      "fast-route",
      "mock-payment-create-gate.json",
    ),
    PAYMENT_MOCK_PROVIDER_QUERY_FAULT_PATH: containerStatePath(
      "fast-route",
      "mock-payment-query-fault.json",
    ),
    MEDIA_ASSET_STORAGE_ROOT: "/var/lib/vem/service-api/media-assets",
    SERVICE_PORT: "3000",
  };
}

export function renderBackendComposeEnv(options) {
  return `${Object.entries(buildBackendComposeEnvironment(options))
    .map(([name, value]) => `${name}=${quoteComposeEnv(value)}`)
    .join("\n")}\n`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function renderYamlEnvironment(values) {
  return Object.entries(values)
    .map(([name, value]) => `      ${name}: ${yamlString(value)}`)
    .join("\n");
}

export function renderBackendComposeOverride(options) {
  return `services:
  postgres:
    container_name: ${SERVICE_NAMES.postgres}
    ports:
      - "55432:5432"
  mqtt:
    container_name: ${SERVICE_NAMES.mqtt}
    ports:
      - "18883:1883"
  service-api:
    image: ${SERVICE_API_SOURCE_IMAGE}
    working_dir: ${SERVICE_API_CONTAINER_WORKSPACE}
    command: ["node", "${SERVICE_API_CONTAINER_WORKSPACE}/apps/service-api/dist/main.js"]
    volumes:
      - ${yamlString(`${options.workspace}:${SERVICE_API_CONTAINER_WORKSPACE}`)}
      - ${yamlString(`${options.stateRoot}:${SERVICE_API_CONTAINER_STATE_ROOT}`)}
    environment:
${renderYamlEnvironment(buildComposeServiceApiEnvironment(options))}
`;
}

export async function writeBackendComposeFiles(options) {
  await Promise.all([
    writeFile(backendComposeEnvFile(options), renderBackendComposeEnv(options)),
    writeFile(
      backendComposeOverrideFile(options),
      renderBackendComposeOverride(options),
    ),
  ]);
}

export function buildBackendComposeCommand(options, args) {
  return commandLine("docker", [
    "compose",
    "--env-file",
    backendComposeEnvFile(options),
    "-f",
    backendComposeFile(options),
    "-f",
    backendComposeOverrideFile(options),
    "-p",
    BACKEND_COMPOSE_PROJECT,
    ...args,
  ]);
}

function buildLegacyBackendResourceCleanupCommand() {
  return commandLine("sh", [
    "-c",
    [
      `docker rm -f ${SERVICE_NAMES.postgres} ${SERVICE_NAMES.mqtt} >/dev/null 2>&1 || true`,
      `docker volume rm -f ${VOLUME_NAMES.postgres} ${VOLUME_NAMES.mqtt} >/dev/null 2>&1 || true`,
    ].join("; "),
  ]);
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
    buildBackendComposeCommand(options, [
      "down",
      "--remove-orphans",
      "--volumes",
    ]),
    buildLegacyBackendResourceCleanupCommand(),
    renderPublishedCommand(binding.reconstructCommand, options, contract),
    buildBackendComposeCommand(options, ["up", "-d", "postgres", "mqtt"]),
    commandLine("pnpm", [
      "turbo",
      "build",
      "--filter",
      "@vem/shared",
      "--filter",
      "@vem/db",
      "--filter",
      "service-api",
      "--filter=admin-ui",
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

async function buildDirectoryIdentity(workspace, relativeDirectory) {
  const files = await sourceFilesUnder(workspace, relativeDirectory, readdir);
  const members = await Promise.all(
    files.map(async (path) => {
      const bytes = await readFile(join(workspace, path));
      return {
        name: path.slice(relativeDirectory.length + 1).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
      };
    }),
  );
  if (members.length === 0) {
    throw new Error(`${relativeDirectory} build output is empty`);
  }
  return {
    byteSize: members.reduce((total, member) => total + member.byteSize, 0),
    fileCount: members.length,
    sha256: createHash("sha256")
      .update(
        members
          .map(
            (member) =>
              `${member.name}\0${member.sha256}\0${member.byteSize}\n`,
          )
          .join(""),
      )
      .digest("hex"),
  };
}

async function observeAdminUiDelivery(indexBytes) {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-length": indexBytes.byteLength,
      "content-type": "text/html; charset=utf-8",
    });
    response.end(indexBytes);
  });
  try {
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("local testbed Admin UI observer address is invalid");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      signal: AbortSignal.timeout(5_000),
    });
    const observed = Buffer.from(await response.arrayBuffer());
    if (!response.ok || !observed.equals(indexBytes)) {
      throw new Error("local testbed Admin UI delivery observation failed");
    }
    return {
      byteSize: observed.byteLength,
      method: "GET",
      responseSha256: createHash("sha256").update(observed).digest("hex"),
      status: response.status,
    };
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  }
}

export async function buildBackendAcceptanceIdentity(workspace, health) {
  const root = absolute(workspace, "workspace");
  if (health?.database !== "ok" || health?.mqtt !== "connected") {
    throw new Error("local testbed Service API runtime health is invalid");
  }
  const [serviceApi, adminUi, serviceEntrypoint, adminEntrypoint] =
    await Promise.all([
      buildDirectoryIdentity(root, "apps/service-api/dist"),
      buildDirectoryIdentity(root, "apps/admin-ui/dist"),
      readFile(join(root, "apps/service-api/dist/main.js")),
      readFile(join(root, "apps/admin-ui/dist/index.html")),
    ]);
  if (serviceEntrypoint.byteLength === 0 || adminEntrypoint.byteLength === 0) {
    throw new Error("local testbed backend runtime entrypoint is empty");
  }
  const adminDelivery = await observeAdminUiDelivery(adminEntrypoint);
  return {
    serviceApi: {
      build: serviceApi,
      runtime: {
        database: health.database,
        entrypoint: "main.js",
        health: "ready",
        mqtt: health.mqtt,
      },
    },
    adminUi: {
      build: adminUi,
      delivery: { entrypoint: "index.html", observedHttp: adminDelivery },
    },
  };
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
  pruneCaches = true,
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
    if (pruneCaches) await pruneOldCaches();
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
  if (pruneCaches) await pruneOldCaches();
  return { ...layout, cache: "miss" };
}

export function buildHostLocalServiceApiEnvironment(options) {
  const createOrderGate = paymentMockCreateGatePaths(options.stateRoot);
  const queryFault = paymentMockQueryFaultPaths(options.stateRoot);
  return {
    NODE_ENV: "development",
    DATABASE_URL: `postgresql://${LOCAL_TESTBED_POSTGRES_USER}:${LOCAL_TESTBED_POSTGRES_PASSWORD}@127.0.0.1:55432/${LOCAL_TESTBED_POSTGRES_DB}`,
    MQTT_URL: "mqtt://127.0.0.1:18883",
    MACHINE_MQTT_URL: `mqtt://${options.hostPrivateAddress}:18883`,
    MQTT_USERNAME: LOCAL_TESTBED_MQTT_USERNAME,
    MQTT_PASSWORD: LOCAL_TESTBED_MQTT_PASSWORD,
    MACHINE_API_BASE_URL: `http://${options.hostPrivateAddress}:26849/api`,
    PAYMENT_WEBHOOK_BASE_URL: `http://${options.hostPrivateAddress}:26849`,
    PAYMENT_MOCK_ENABLED: "true",
    PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH: createOrderGate.statePath,
    PAYMENT_MOCK_PROVIDER_QUERY_FAULT_PATH: queryFault.statePath,
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
    MEDIA_ASSET_STORAGE_ROOT: join(
      options.stateRoot,
      "service-api-media-assets",
    ),
    PAYMENT_CONFIG_ENCRYPTION_KEY:
      "local-payment-config-encryption-key-32-chars",
  };
}

export {
  paymentMockCreateGatePaths,
  paymentMockQueryFaultPaths,
} from "./mock-payment-create-gate.ts";

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

export function buildServiceApiComposePlan(options) {
  return [
    buildBackendComposeCommand(options, ["rm", "-sf", "service-api"]),
    buildBackendComposeCommand(options, [
      "up",
      "-d",
      "--force-recreate",
      "service-api",
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
    token = createHash("sha256")
      .update(
        `${options.runId}\n${options.hostPrivateAddress}\n${options.stateRoot}`,
      )
      .digest("hex"),
  } = {},
) {
  const unit = `${HOST_CONTROL_PLANE_UNIT}.service`;
  const adapterPath = join(
    options.workspace,
    "scripts/testbed/qemu-usb-serial-host-adapter.ts",
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
      `--setenv=VEM_LOCAL_TESTBED_MQTT_USERNAME=${LOCAL_TESTBED_MQTT_USERNAME}`,
      `--setenv=VEM_LOCAL_TESTBED_MQTT_PASSWORD=${LOCAL_TESTBED_MQTT_PASSWORD}`,
      `--setenv=VEM_VM_HOST_ADAPTER=${adapterPath}`,
      "--setenv=VEM_VM_HOST_ADAPTER_VERSION=1.0.0",
      `--setenv=VEM_VM_HOST_ADAPTER_SHA256=sha256:${adapterDigest}`,
      `--setenv=VEM_VM_HOST_ADAPTER_DOMAIN=${baselineDomainName(contract)}`,
      `--setenv=VEM_VM_HOST_ADAPTER_STATE_ROOT=${join(options.stateRoot, "host-adapter")}`,
      `--setenv=VEM_LOWER_CONTROLLER_SIM=${lowerControllerSimPath}`,
      process.execPath,
      "scripts/testbed/host-serial-control-plane.ts",
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
      join(options.workspace, "scripts/testbed/local-testbed-host.ts"),
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
  let consecutiveReadyChecks = 0;
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
      consecutiveReadyChecks += 1;
      if (consecutiveReadyChecks >= 2) return;
    } catch {
      consecutiveReadyChecks = 0;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
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

function installationFixturePath(
  fixturePath = process.env[INSTALLATION_ALIPAY_SANDBOX_FIXTURE_ENV],
) {
  if (typeof fixturePath !== "string" || fixturePath.trim() === "") {
    throw new Error(
      `${INSTALLATION_ALIPAY_SANDBOX_FIXTURE_ENV} must identify the host-owned Alipay sandbox fixture`,
    );
  }
  return absolute(fixturePath, INSTALLATION_ALIPAY_SANDBOX_FIXTURE_ENV);
}

function validateAlipayFixtureChannels(fixture) {
  const channels = fixture?.channelPolicy?.channels;
  if (
    !Array.isArray(channels) ||
    !["qr_code:alipay", "payment_code:alipay"].every((channelKey) =>
      channels.some(
        (channel) =>
          channel?.channelKey === channelKey && channel?.enabled === true,
      ),
    )
  ) {
    throw new Error(
      "installation-owned Alipay fixture must enable qr_code:alipay and payment_code:alipay",
    );
  }
}

export async function prepareInstallationOwnedPaymentProvider({
  baseUrl,
  fixturePath,
  readFixture = async (path) => JSON.parse(await readFile(path, "utf8")),
  request = requestJson,
}) {
  const resolvedFixturePath = installationFixturePath(fixturePath);
  const fixture = validateInstallationOwnedAlipaySandboxFixture(
    await readFixture(resolvedFixturePath),
  );
  validateAlipayFixtureChannels(fixture);
  const login = await request(baseUrl, "/auth/login", {
    method: "POST",
    body: {
      username: LOCAL_TESTBED_ADMIN_USERNAME,
      password: LOCAL_TESTBED_ADMIN_PASSWORD,
    },
  });
  const token = required(
    login?.accessToken,
    "host preparation admin access token",
  );
  const providers = await request(baseUrl, "/payments/providers", { token });
  const alipay = Array.isArray(providers)
    ? providers.find((provider) => provider?.code === "alipay")
    : null;
  const providerId = required(alipay?.id, "Alipay provider id");
  await request(baseUrl, `/payments/providers/${providerId}`, {
    method: "PATCH",
    token,
    body: { status: "enabled" },
  });
  const config = await request(baseUrl, "/payments/provider-configs", {
    method: "POST",
    token,
    body: fixture.providerConfig,
  });
  await request(baseUrl, "/payments/channel-policy", {
    method: "PUT",
    token,
    body: fixture.channelPolicy,
  });
  const publicConfig = fixture.providerConfig.publicConfigJson;
  const providerConfigId = required(config?.id, "Alipay provider config id");
  const configured = await request(baseUrl, "/payments/provider-configs", {
    token,
  });
  const projection = Array.isArray(configured)
    ? configured.find((entry) => entry?.id === providerConfigId)
    : null;
  if (
    projection?.providerCode !== "alipay" ||
    projection?.publicConfigJson?.mode !== publicConfig.mode ||
    projection?.publicConfigJson?.gatewayUrl !== publicConfig.gatewayUrl ||
    projection?.publicConfigJson?.keyType !== publicConfig.keyType
  ) {
    throw new Error(
      "host-side Alipay provider configuration preflight did not match the imported public identity",
    );
  }
  return {
    identity: {
      providerCode: "alipay",
      providerConfigId,
      appId: required(fixture.providerConfig.appId, "Alipay appId"),
      merchantNo: required(
        fixture.providerConfig.merchantNo,
        "Alipay merchantNo",
      ),
      mode: publicConfig.mode,
      gatewayUrl: publicConfig.gatewayUrl,
      keyType: publicConfig.keyType,
    },
    hostPreparation: {
      source: "host_installation_fixture",
      preflight: "configured",
    },
  };
}

function testbedTryOnGarmentAsset(template = "tshirt_short_sleeve") {
  const longSleeve = template === "tshirt_long_sleeve";
  return {
    fileName: longSleeve
      ? "local-testbed-try-on-garment-long.png"
      : "local-testbed-try-on-garment.png",
    contentType: "image/png",
    buffer: longSleeve
      ? TESTBED_MEDIA_FIXTURES.tryOnGarmentLong
      : TESTBED_MEDIA_FIXTURES.tryOnGarment,
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBuffer.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, payload])),
    8 + payload.length,
  );
  return chunk;
}

function createRgbaPng(width, height, pixel) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = pixel(x, y, width, height);
      const offset = y * stride + 1 + x * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = alpha;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createProductFixturePng({ background, accent }) {
  return createRgbaPng(240, 240, (x, y, width, height) => {
    const inAccentBand = x > width * 0.12 && x < width * 0.22;
    const inProductBlock =
      x > width * 0.32 &&
      x < width * 0.84 &&
      y > height * 0.22 &&
      y < height * 0.78;
    if (inAccentBand) return [...accent, 255];
    if (inProductBlock) return [246, 248, 250, 255];
    return [...background, 255];
  });
}

// Product display and transparent garment images are deterministic fixtures.
// The garment follows the production Admin upload contract rather than a
// customer overlay transport.
const TESTBED_MEDIA_FIXTURES = Object.freeze({
  tryOnGarment: createRgbaPng(512, 640, (x, y, width, height) => {
    const torso =
      x > width * 0.24 &&
      x < width * 0.76 &&
      y > height * 0.26 &&
      y < height * 0.9;
    const sleeves =
      y > height * 0.2 &&
      y < height * 0.52 &&
      ((x > width * 0.08 && x < width * 0.26) ||
        (x > width * 0.74 && x < width * 0.92));
    return torso || sleeves ? [38, 128, 212, 235] : [0, 0, 0, 0];
  }),
  tryOnGarmentLong: createRgbaPng(512, 640, (x, y, width, height) => {
    const torso =
      x > width * 0.27 &&
      x < width * 0.73 &&
      y > height * 0.24 &&
      y < height * 0.92;
    const sleeves =
      y > height * 0.2 &&
      y < height * 0.82 &&
      ((x > width * 0.09 && x < width * 0.28) ||
        (x > width * 0.72 && x < width * 0.91));
    return torso || sleeves ? [119, 58, 173, 235] : [0, 0, 0, 0];
  }),
  productDisplayImages: Object.freeze({
    袜子: createProductFixturePng({
      background: [32, 91, 76],
      accent: [248, 193, 68],
    }),
    内裤: createProductFixturePng({
      background: [95, 64, 137],
      accent: [63, 198, 181],
    }),
    T恤: createProductFixturePng({
      background: [163, 74, 58],
      accent: [97, 151, 206],
    }),
  }),
});

const TESTBED_PRODUCT_DISPLAY_IMAGE_FIXTURES = Object.freeze({
  袜子: "socks",
  内裤: "underwear",
  T恤: "tshirts",
});

function testbedProductDisplayImageAsset(category) {
  const fixtureKey = TESTBED_PRODUCT_DISPLAY_IMAGE_FIXTURES[category];
  const buffer = TESTBED_MEDIA_FIXTURES.productDisplayImages[category];
  if (!fixtureKey || !buffer) {
    throw new Error(
      `local testbed has no product display image fixture for ${category}`,
    );
  }
  return {
    fileName: `local-testbed-${category}-main-image.png`,
    contentType: "image/png",
    buffer,
  };
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
      const payload = await response.json();
      if (
        response.ok &&
        payload?.data?.database === "ok" &&
        payload?.data?.mqtt === "connected"
      ) {
        return {
          database: payload.data.database,
          mqtt: payload.data.mqtt,
        };
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("local testbed Service API did not become ready");
}

async function waitForHostControlPlane(endpoint, token) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("local testbed host control plane did not become ready");
}

async function serviceApiFailure(error, options = null) {
  let log = {
    kind: "unavailable",
    text: "docker compose logs was not attempted",
  };
  if (options) {
    try {
      const command = buildBackendComposeCommand(options, [
        "logs",
        "--no-color",
        "--tail",
        "200",
        "service-api",
      ]);
      const result = await runCapture(command.command, command.args);
      log = interpretServiceApiJournalCapture({
        ok: true,
        stdout: result.stdout,
      });
    } catch (logError) {
      log = interpretServiceApiJournalCapture({
        ok: false,
        error: logError instanceof Error ? logError.message : String(logError),
      });
    }
  }
  const suffix =
    log.kind === "journal"
      ? `--- local Service API compose log ---\n${log.text}`
      : `--- local Service API compose log unavailable ---\n${log.text}`;
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
      username: LOCAL_TESTBED_ADMIN_USERNAME,
      password: LOCAL_TESTBED_ADMIN_PASSWORD,
    },
  });
  const token = login.accessToken;
  const tryOnGarmentAsset = await upload(
    baseUrl,
    "/media-assets/try-on-garments",
    {
      token,
      ...testbedTryOnGarmentAsset(),
    },
  );
  const longTryOnGarmentAsset = await upload(
    baseUrl,
    "/media-assets/try-on-garments",
    {
      token,
      ...testbedTryOnGarmentAsset("tshirt_long_sleeve"),
    },
  );
  const productDisplayAssetsByCategory = new Map();
  for (const category of Object.keys(TESTBED_PRODUCT_DISPLAY_IMAGE_FIXTURES)) {
    productDisplayAssetsByCategory.set(
      category,
      await upload(baseUrl, "/media-assets/product-display-images", {
        token,
        ...testbedProductDisplayImageAsset(category),
      }),
    );
  }
  const products = [];
  for (const [index, entry] of fixture.products.entries()) {
    const displayImageAsset = productDisplayAssetsByCategory.get(
      entry.category,
    );
    if (!displayImageAsset) {
      throw new Error(
        `local testbed fixture product category has no display image asset: ${entry.category}`,
      );
    }
    const product = await request(baseUrl, "/products", {
      method: "POST",
      token,
      body: {
        name: entry.name,
        description: `${entry.category} normalized testbed fixture`,
        displayImageMediaAssetId: displayImageAsset.id,
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
    products.push({ ...entry, product, variant, displayImageAsset });
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
  for (const fixtureSlot of fixture.slots) {
    const slot = {
      ...fixtureSlot,
      onHandQty: Math.min(fixtureSlot.onHandQty, fixtureSlot.capacity),
    };
    const machineSlot = await request(
      baseUrl,
      `/machines/${machine.id}/slots`,
      {
        method: "POST",
        token,
        body: {
          rowNo: slot.rowNo,
          cellNo: slot.cellNo,
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
  const recommendationBase = seededSlots.find(
    (entry) => entry.slot.sourceRow === VISION_RECOMMENDATION_BASE_SOURCE_ROW,
  );
  if (!recommendationBase || recommendationBase.product.category !== "T恤") {
    throw new Error(
      "Vision recommendation fixture requires the configured T-shirt source row",
    );
  }
  const unmatchedRecommendation = seededSlots.find(
    (entry) =>
      entry.slot.sourceRow === VISION_RECOMMENDATION_UNMATCHED_SOURCE_ROW,
  );
  if (!unmatchedRecommendation) {
    throw new Error(
      "Vision recommendation fixture requires the configured unmatched source row",
    );
  }
  const recommendationVariants = [];
  const planogramSeededSlots = [...seededSlots];
  for (const definition of VISION_RECOMMENDATION_VARIANTS) {
    const variant = await request(baseUrl, "/product-variants", {
      method: "POST",
      token,
      body: {
        productId: recommendationBase.product.product.id,
        sku: `${recommendationBase.product.variant.sku}-VISION-${definition.size}`,
        size: definition.size,
        color: null,
        priceCents: recommendationBase.slot.priceCents,
        status: "active",
      },
    });
    const machineSlot = await request(
      baseUrl,
      `/machines/${machine.id}/slots`,
      {
        method: "POST",
        token,
        body: {
          rowNo: definition.rowNo,
          cellNo: definition.cellNo,
          capacity: recommendationBase.slot.capacity,
          status: "enabled",
        },
      },
    );
    const inventory = await request(baseUrl, "/inventories", {
      method: "POST",
      token,
      body: {
        machineId: machine.id,
        slotId: machineSlot.id,
        variantId: variant.id,
        onHandQty: recommendationBase.slot.onHandQty,
        reservedQty: 0,
        lowStockThreshold: recommendationBase.slot.lowStockThreshold,
        note: "local testbed vision recommendation fixture",
      },
    });
    const slot = {
      ...recommendationBase.slot,
      rowNo: definition.rowNo,
      cellNo: definition.cellNo,
      slotDisplayLabel: `R${definition.rowNo}C${definition.cellNo}`,
    };
    planogramSeededSlots.push({
      slot,
      product: {
        ...recommendationBase.product,
        size: definition.size,
        variant,
      },
      machineSlot,
      inventory,
    });
    recommendationVariants.push({
      productId: recommendationBase.product.product.id,
      variantId: variant.id,
      sku: variant.sku,
      size: definition.size,
      slotId: machineSlot.id,
      inventoryId: inventory.id,
      onHandQty: recommendationBase.slot.onHandQty,
    });
  }
  const createGarment = async (sourceMediaAssetId, template, colorLabel) => {
    const draft = await request(baseUrl, "/try-on-garments", {
      method: "POST",
      token,
      body: {
        productId: recommendationBase.product.product.id,
        colorLabel,
        sourceMediaAssetId,
        template,
      },
    });
    for (const action of ["confirmation", "activation"]) {
      await request(baseUrl, `/try-on-garments/${draft.id}/${action}`, {
        method: "POST",
        token,
        body: {},
      });
    }
    return draft;
  };
  const shortDraft = await createGarment(
    tryOnGarmentAsset.id,
    "tshirt_short_sleeve",
    "测试蓝",
  );
  const longDraft = await createGarment(
    longTryOnGarmentAsset.id,
    "tshirt_long_sleeve",
    "测试紫",
  );
  const shortVariant = recommendationVariants[0];
  const longVariant = recommendationVariants[1];
  const tryOnGarment = await request(
    baseUrl,
    `/try-on-garments/${shortDraft.id}/variant-associations`,
    { method: "PUT", token, body: { variantIds: [shortVariant.variantId] } },
  );
  const longTryOnGarment = await request(
    baseUrl,
    `/try-on-garments/${longDraft.id}/variant-associations`,
    { method: "PUT", token, body: { variantIds: [longVariant.variantId] } },
  );
  const planogramVersion = "LOCAL-TESTBED-V1";
  await request(baseUrl, `/machines/${machine.id}/planogram-versions`, {
    method: "POST",
    token,
    body: {
      planogramVersion,
      slots: planogramSeededSlots.map(
        ({ slot, product, machineSlot, inventory }) => ({
          slotId: machineSlot.id,
          rowNo: slot.rowNo,
          cellNo: slot.cellNo,
          inventoryId: inventory.id,
          variantId: product.variant.id,
          productId: product.product.id,
          productName: product.name,
          productDescription: `${product.category} normalized testbed fixture`,
          coverImageUrl: product.displayImageAsset.publicUrl,
          categoryId: null,
          categoryName: null,
          sku: product.variant.sku,
          size: product.size,
          color: null,
          priceCents: slot.priceCents,
          productSortOrder: product.sourceRow,
          capacity: slot.capacity,
          parLevel: slot.lowStockThreshold,
        }),
      ),
    },
  });
  const claim = await request(baseUrl, `/machines/${machine.id}/claim-codes`, {
    method: "POST",
    token,
    body: { purpose: "first_claim" },
  });
  const productMedia = ["socks", "underwear", "tshirts"].map((categoryKey) => {
    const seededSlot = seededSlots.find(
      (entry) => categoryKeyForFixtureProduct(entry.product) === categoryKey,
    );
    if (!seededSlot) {
      throw new Error(
        `local testbed fixture requires a ${categoryKey} product media binding`,
      );
    }
    const product = seededSlot.product;
    return {
      categoryKey,
      catalogKey: `product:${product.product.id}`,
      productId: product.product.id,
      coverImageUrl: product.displayImageAsset.publicUrl,
    };
  });
  return {
    machine,
    claim,
    planogramVersion,
    apiBaseUrl: baseUrl,
    mqttUrl: `mqtt://${hostPrivateAddress}:18883`,
    visionAcceptance: {
      tryOnGarmentId: tryOnGarment.id,
      tryOnGarmentMediaAssetId: tryOnGarmentAsset.id,
      tryOnCategoryKey: "tshirts",
      selectedCatalogKey: `product:${recommendationBase.product.product.id}`,
      selectedVariantId: recommendationVariants[0].variantId,
      recommendationVariants,
      unmatchedRecommendationVariant: {
        productId: unmatchedRecommendation.product.product.id,
        variantId: unmatchedRecommendation.product.variant.id,
        sku: unmatchedRecommendation.product.variant.sku,
        size: unmatchedRecommendation.product.size,
        slotId: unmatchedRecommendation.machineSlot.id,
        inventoryId: unmatchedRecommendation.inventory.id,
      },
      seededTryOnVariants: [
        {
          sourceRow: recommendationBase.slot.sourceRow,
          productId: shortVariant.productId,
          variantId: shortVariant.variantId,
          sku: shortVariant.sku,
          size: shortVariant.size,
          garmentId: tryOnGarment.id,
          garmentMediaAssetId: tryOnGarmentAsset.id,
        },
        {
          sourceRow: recommendationBase.slot.sourceRow,
          productId: longVariant.productId,
          variantId: longVariant.variantId,
          sku: longVariant.sku,
          size: longVariant.size,
          garmentId: longTryOnGarment.id,
          garmentMediaAssetId: longTryOnGarmentAsset.id,
        },
      ],
      aiTryOnCases: [
        {
          caseKey: "short",
          template: "tshirt_short_sleeve",
          garmentId: tryOnGarment.id,
          garmentMediaAssetId: tryOnGarmentAsset.id,
          garmentSha256: createHash("sha256")
            .update(TESTBED_MEDIA_FIXTURES.tryOnGarment)
            .digest("hex"),
          selectedCatalogKey: `product:${shortVariant.productId}`,
          selectedVariantId: shortVariant.variantId,
          size: shortVariant.size,
        },
        {
          caseKey: "long",
          template: "tshirt_long_sleeve",
          garmentId: longTryOnGarment.id,
          garmentMediaAssetId: longTryOnGarmentAsset.id,
          garmentSha256: createHash("sha256")
            .update(TESTBED_MEDIA_FIXTURES.tryOnGarmentLong)
            .digest("hex"),
          selectedCatalogKey: `product:${longVariant.productId}`,
          selectedVariantId: longVariant.variantId,
          size: longVariant.size,
        },
      ],
      productMedia,
    },
    slots: seededSlots.map(({ slot, product, machineSlot, inventory }) => ({
      slotId: machineSlot.id,
      rowNo: slot.rowNo,
      cellNo: slot.cellNo,
      slotDisplayLabel: slot.slotDisplayLabel,
      categoryKey: categoryKeyForFixtureProduct(product),
      inventoryId: inventory.id,
      onHandQty: slot.onHandQty,
      sku: product.variant.sku,
    })),
  };
}

async function stopServiceApiUnit(options) {
  const stop = buildServiceApiComposePlan(options)[0];
  await run(stop.command, stop.args, { stdio: "ignore" }).catch(
    () => undefined,
  );
}

async function startServiceApiUnit(options) {
  const start = buildServiceApiComposePlan(options).at(-1);
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
  token,
) {
  const start = buildHostControlPlaneUnitPlan(options, contract, {
    lowerControllerSimPath,
    ...(token ? { token } : {}),
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

export function buildRefreshHostRuntimePlan(options) {
  return [
    buildBackendComposeCommand(options, ["up", "-d", "postgres", "mqtt"]),
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
  ];
}

export function validateRefreshGuestInput(
  input,
  options,
  expectedFixtureIdentity,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("existing guest input must be an object");
  }
  if (input.schemaVersion !== "vem-local-testbed-guest-input/v1") {
    throw new Error("existing guest input schemaVersion is invalid");
  }
  if (
    typeof input.machineCode !== "string" ||
    typeof input.claimCode !== "string" ||
    !input.fixtureAllocation ||
    typeof input.fixtureAllocation !== "object" ||
    !input.hostControlPlane ||
    typeof input.hostControlPlane !== "object" ||
    typeof input.hostControlPlane.token !== "string" ||
    input.hostControlPlane.token.length === 0
  ) {
    throw new Error(
      "existing guest input must retain machine, claim, fixture, and host control plane token",
    );
  }
  const endpoint = `http://${options.hostPrivateAddress}:${HOST_CONTROL_PLANE_PORT}`;
  if (input.hostControlPlane.endpoint !== endpoint) {
    throw new Error(
      "existing guest input host control plane endpoint is invalid",
    );
  }
  if (
    expectedFixtureIdentity &&
    input.fixtureIdentity?.sha256 !== expectedFixtureIdentity.sha256
  ) {
    throw new Error("existing guest input fixture identity is stale");
  }
  return input;
}

export function refreshGuestInputForRun(
  input,
  runId,
  paymentProvider,
  interactiveUserPassword,
) {
  return {
    ...input,
    runId: required(runId, "--run-id"),
    ...(paymentProvider === undefined ? {} : { paymentProvider }),
    ...(interactiveUserPassword === undefined
      ? {}
      : { interactiveUserPassword }),
  };
}

export async function reprepareGuestInputForRefresh({
  input,
  runId,
  baseUrl,
  preparePaymentProvider = prepareInstallationOwnedPaymentProvider,
}) {
  const paymentProvider = await preparePaymentProvider({ baseUrl });
  return refreshGuestInputForRun(input, runId, paymentProvider);
}

export async function refreshPlatformFixtureForRun({
  input,
  baseUrl,
  fixture,
  hostPrivateAddress,
  request = requestJson,
  upload = uploadMultipartFile,
  seedPlatform = seedThroughSupportedApis,
}) {
  const login = await request(baseUrl, "/auth/login", {
    method: "POST",
    body: {
      username: LOCAL_TESTBED_ADMIN_USERNAME,
      password: LOCAL_TESTBED_ADMIN_PASSWORD,
    },
  });
  const token = login.accessToken;
  const machinesPage = await request(baseUrl, "/machines?page=1&pageSize=100", {
    token,
  });
  const existingMachine = (machinesPage.items ?? []).find(
    (machine) => machine.code === input.machineCode,
  );
  if (existingMachine) return input;

  const seeded = await seedPlatform({
    baseUrl,
    fixture,
    hostPrivateAddress,
    request,
    upload,
  });
  return {
    ...input,
    fixtureAllocation: allocateFullWorkflowFixtures(seeded.slots),
    claimCode: seeded.claim.claimCode,
    machineCode: seeded.machine.code,
    planogramVersion: seeded.planogramVersion,
    visionAcceptance: seeded.visionAcceptance,
  };
}

async function stageExistingGuestInput(options, contract) {
  const guest = contract.testbed.guest;
  const ssh = [
    "-i",
    guest.identityFile,
    "-o",
    `UserKnownHostsFile=${guest.knownHostsFile}`,
  ];
  await run("ssh", [
    ...ssh,
    `${guest.user}@${guest.host}`,
    `powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${guest.stagingPath}') | Out-Null\"`,
  ]);
  await run("scp", [
    ...ssh,
    join(options.stateRoot, "guest-input.json"),
    `${guest.user}@${guest.host}:${guest.stagingPath}`,
  ]);
}

export async function refreshHostRuntime(options) {
  const [contract, fixtureDocument] = await Promise.all([
    readFile(options.baselineContract, "utf8")
      .then(JSON.parse)
      .then(validateBaselineContract),
    loadFixtureDocument(),
  ]);
  const guestInputPath = join(options.stateRoot, "guest-input.json");
  const existingGuestInputRaw = await readFile(guestInputPath, "utf8");
  let guestInput = refreshGuestInputForRun(
    validateRefreshGuestInput(
      JSON.parse(existingGuestInputRaw),
      options,
      fixtureDocument.identity,
    ),
    options.runId,
  );
  let guestInputRaw = `${JSON.stringify(guestInput, null, 2)}\n`;
  const plan = buildRefreshHostRuntimePlan(options);
  const startedAt = new Date().toISOString();
  if (options.dryRun) {
    return {
      schemaVersion: "vem-local-testbed-host-runtime-refresh/v1",
      dryRun: true,
      plan,
      guestInput: {
        sha256: `sha256:${createHash("sha256").update(guestInputRaw).digest("hex")}`,
        machineCode: guestInput.machineCode,
        claimCode: guestInput.claimCode,
      },
    };
  }
  const interactiveUserPassword =
    await readBaselineInteractiveUserPassword(contract);
  const buildStartedAt = new Date().toISOString();
  await writeBackendComposeFiles(options);
  await run(plan[0].command, plan[0].args, {
    cwd: options.workspace,
    env: plan[0].env,
  });
  await waitForPostgres();
  for (const step of plan.slice(1)) {
    await run(step.command, step.args, {
      cwd: options.workspace,
      env: step.env,
    });
  }
  const hostSimulator = await ensureLowerControllerSimCached({
    options,
    pruneCaches: false,
  });
  const buildFinishedAt = new Date().toISOString();
  await stopServiceApiUnit(options);
  await stopHostControlPlaneUnit(options, contract);
  const restartStartedAt = new Date().toISOString();
  await startServiceApiUnit(options);
  const apiBaseUrl = "http://127.0.0.1:26849/api";
  try {
    await waitForApi(apiBaseUrl);
  } catch (error) {
    throw await serviceApiFailure(error, options);
  }
  try {
    guestInput = await refreshPlatformFixtureForRun({
      input: guestInput,
      runId: options.runId,
      baseUrl: apiBaseUrl,
      fixture: fixtureDocument.fixture,
      hostPrivateAddress: options.hostPrivateAddress,
    });
    guestInput = await reprepareGuestInputForRefresh({
      input: guestInput,
      runId: options.runId,
      baseUrl: apiBaseUrl,
    });
    guestInput = refreshGuestInputForRun(
      guestInput,
      options.runId,
      undefined,
      interactiveUserPassword,
    );
    guestInputRaw = `${JSON.stringify(guestInput, null, 2)}\n`;
  } catch (error) {
    throw await serviceApiFailure(error, options);
  }
  await writeFile(guestInputPath, guestInputRaw, "utf8");
  await startHostControlPlaneUnit(
    options,
    contract,
    hostSimulator.binaryPath,
    guestInput.hostControlPlane.token,
  );
  await waitForHostControlPlane(
    guestInput.hostControlPlane.endpoint,
    guestInput.hostControlPlane.token,
  );
  await stageExistingGuestInput(options, contract);
  const finishedAt = new Date().toISOString();
  return {
    schemaVersion: "vem-local-testbed-host-runtime-refresh/v1",
    workspace: options.workspace,
    guestInput: {
      sha256: `sha256:${createHash("sha256").update(guestInputRaw).digest("hex")}`,
      machineCode: guestInput.machineCode,
      claimCode: guestInput.claimCode,
      fixtureAllocation: guestInput.fixtureAllocation,
      hostControlPlane: { endpoint: guestInput.hostControlPlane.endpoint },
    },
    hostSimulator: {
      cache: hostSimulator.cache,
      sourceDigest: hostSimulator.sourceDigest,
    },
    timing: {
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      build: {
        startedAt: buildStartedAt,
        finishedAt: buildFinishedAt,
        durationMs: Date.parse(buildFinishedAt) - Date.parse(buildStartedAt),
      },
      restart: {
        startedAt: restartStartedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(restartStartedAt),
      },
    },
  };
}

async function reconstruct(options) {
  const [contract, fixtureDocument] = await Promise.all([
    readFile(options.baselineContract, "utf8")
      .then(JSON.parse)
      .then(validateBaselineContract),
    loadFixtureDocument(),
  ]);
  const fixture = fixtureDocument.fixture;
  await Promise.all([
    mkdir(options.stateRoot, { recursive: true }),
    mkdir(join(options.stateRoot, "service-api-runtime"), {
      recursive: true,
    }),
  ]);
  await writeBackendComposeFiles(options);
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
  writePaymentMockQueryFaultState(options.stateRoot, { state: "open" });
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
  await run(plan[0].command, plan[0].args, { stdio: "ignore" }).catch(
    () => undefined,
  );
  await run(plan[1].command, plan[1].args, { stdio: "ignore" }).catch(
    () => undefined,
  );
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
    await run(plan[3].command, plan[3].args, { cwd: options.workspace });
    await waitForPostgres();
    for (const step of plan.slice(4, 6))
      await run(step.command, step.args, {
        cwd: options.workspace,
        env: step.env,
      });
    await startServiceApiUnit(options);
    const apiBaseUrl = "http://127.0.0.1:26849/api";
    let serviceApiHealth;
    try {
      serviceApiHealth = await waitForApi(apiBaseUrl);
    } catch (error) {
      throw await serviceApiFailure(error, options);
    }
    await startHostControlPlaneUnit(
      options,
      contract,
      hostSimulator.binaryPath,
    );
    let seeded;
    let paymentProvider;
    const interactiveUserPassword =
      await readBaselineInteractiveUserPassword(contract);
    try {
      seeded = await seedThroughSupportedApis({
        baseUrl: apiBaseUrl,
        fixture,
        hostPrivateAddress: options.hostPrivateAddress,
      });
      paymentProvider = await prepareInstallationOwnedPaymentProvider({
        baseUrl: apiBaseUrl,
      });
      identity.backend = await buildBackendAcceptanceIdentity(
        options.workspace,
        serviceApiHealth,
      );
    } catch (error) {
      throw await serviceApiFailure(error, options);
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
      serviceApi: {
        adminUsername: LOCAL_TESTBED_ADMIN_USERNAME,
        adminPassword: LOCAL_TESTBED_ADMIN_PASSWORD,
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
      paymentProvider,
      fixtureIdentity: fixtureDocument.identity,
      fixtureAllocation: allocateFullWorkflowFixtures(seeded.slots),
      claimCode: seeded.claim.claimCode,
      machineCode: seeded.machine.code,
      planogramVersion: seeded.planogramVersion,
      interactiveUser: "VEMKiosk",
      interactiveUserPassword,
      visionAcceptance: seeded.visionAcceptance,
    };
    const guestInputRaw = `${JSON.stringify(guestInput, null, 2)}\n`;
    await writeFile(
      join(options.stateRoot, "guest-input.json"),
      guestInputRaw,
      "utf8",
    );
    for (const step of plan.slice(6, -1))
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
      workspace: options.workspace,
      workflowIdentity: identity,
      services: SERVICE_NAMES,
      fixture: {
        source: fixture.source,
        productCount: fixture.products.length,
        slots: seeded.slots,
      },
      guestInput: {
        sha256: `sha256:${createHash("sha256").update(guestInputRaw).digest("hex")}`,
        machineCode: seeded.machine.code,
        planogramVersion: seeded.planogramVersion,
        bootstrapPath: contract.testbed.guest.stagingPath,
        fixtureIdentity: fixtureDocument.identity,
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
      timing: {
        reconstruct: {
          startedAt: reconstructionStartedAt,
          finishedAt: reconstructionFinishedAt,
          durationMs:
            Date.parse(reconstructionFinishedAt) -
            Date.parse(reconstructionStartedAt),
        },
        admission: {
          startedAt: admissionStartedAt,
          finishedAt: admissionFinishedAt,
          durationMs:
            Date.parse(admissionFinishedAt) - Date.parse(admissionStartedAt),
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
  const result =
    options.command === "refresh-host-runtime"
      ? await refreshHostRuntime(options)
      : await reconstruct(options);
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
