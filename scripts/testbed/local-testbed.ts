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
const FIELD_TRY_ON_GARMENT = readFileSync(
  new URL(
    `./fixtures/try-on-${["sil", "houette"].join("")}.png`,
    import.meta.url,
  ),
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
export function categoryKeyForFixtureProduct(product: unknown): string {
  const record = product as { category?: unknown; name?: unknown } | null;
  return (
    topCategoryKeyForCatalogItem({
      categoryName: record?.category != null ? String(record.category) : null,
      productName: record?.name != null ? String(record.name) : null,
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
  { size: "中码", rowNo: 2, cellNo: 4 },
  { size: "小码", rowNo: 2, cellNo: 3 },
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function absolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function commandArray(value: unknown, label: string): string[] {
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

function trackedHostCommand(
  value: unknown,
  action: string,
  label: string,
): string[] {
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

function windowsAbsolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function option(
  args: string[],
  name: string,
  optional = false,
): string | undefined {
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

export function validateHostPrivateAddress(
  hostPrivateAddress: unknown,
): string {
  if (
    typeof hostPrivateAddress !== "string" ||
    isIP(hostPrivateAddress) !== 4 ||
    hostPrivateAddress.startsWith("127.")
  ) {
    throw new Error(
      "--host-private-address must be a non-loopback IPv4 address",
    );
  }
  return hostPrivateAddress;
}

export function parseOptions(args: string[]):
  | {
      command: string;
      workspace: string;
      stateRoot: string;
      baselineContract: string;
      hostPrivateAddress: string;
      out: string;
      dryRun: boolean;
      runId: string;
    }
  | {
      command: string;
      workspace: string;
      stateRoot: string;
      baselineContract: string;
      hostPrivateAddress: string;
      out: string;
      dryRun: boolean;
      mode: string;
      runId: string;
    } {
  const command = args[0] ?? "";
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
  if (mode === undefined || !MODES.has(mode))
    throw new Error("--mode must be fast, full, or clear_cache");
  return {
    ...common,
    mode,
    runId: required(option(args, "run-id"), "--run-id"),
  };
}

interface BaselineContract {
  schemaVersion?: unknown;
  releaseId?: unknown;
  destinations?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
  testbed?: {
    reconstructCommand?: unknown;
    admitGuestCommand?: unknown;
    guest?: Record<string, unknown>;
  };
}

export function validateBaselineContract(contract: unknown): BaselineContract {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("baseline contract must be an object");
  }
  const record = contract as Record<string, unknown>;
  if (record.schemaVersion !== "win10-kvm-baseline-current/v1") {
    throw new Error(
      "baseline contract must be the published win10-kvm-baseline-current/v1 manifest",
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/i.test(String(record.releaseId ?? ""))) {
    throw new Error("published baseline contract releaseId is invalid");
  }
  if (!record.destinations || !record.artifacts || !record.testbed) {
    throw new Error(
      "published baseline contract must include destinations, artifacts, and testbed",
    );
  }
  for (const [container, keys] of [
    [
      record.destinations as Record<string, unknown>,
      ["baselinePath", "cacheDiskPath"],
    ],
    [
      record.artifacts as Record<string, unknown>,
      ["systemPath", "cachePath", "domainXmlPath", "diagnosticPath"],
    ],
  ] as Array<[Record<string, unknown>, string[]]>) {
    for (const key of keys) {
      absolute(container[key], `baseline contract ${key}`);
    }
  }
  const binding = record.testbed as Record<string, unknown>;
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
  const guest = binding.guest as Record<string, unknown>;
  for (const key of [
    "host",
    "user",
    "identityFile",
    "knownHostsFile",
    "stagingPath",
    "cacheRoot",
  ]) {
    required(guest[key], `baseline contract guest.${key}`);
  }
  if (guest.user !== "VEMKiosk") {
    throw new Error(
      "baseline contract guest.user must be the production machine user VEMKiosk",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(String(guest.host))) {
    throw new Error(
      "baseline contract guest.host must be a hostname or IP address",
    );
  }
  if (
    !isAbsolute(String(guest.identityFile)) ||
    !isAbsolute(String(guest.knownHostsFile))
  ) {
    throw new Error("baseline contract SSH files must be absolute");
  }
  windowsAbsolute(guest.stagingPath, "baseline contract guest.stagingPath");
  windowsAbsolute(guest.cacheRoot, "baseline contract guest.cacheRoot");
  return contract as BaselineContract;
}

function baselineInteractiveUserPasswordPath(
  contract: BaselineContract,
): string {
  const guest = contract.testbed?.guest ?? {};
  const passwordPath =
    guest.interactiveUserPasswordFile !== undefined
      ? String(guest.interactiveUserPasswordFile)
      : guest.administratorPasswordFile !== undefined
        ? String(guest.administratorPasswordFile)
        : join(dirname(String(guest.identityFile)), "administrator-password");
  if (!isAbsolute(passwordPath)) {
    throw new Error(
      "baseline contract guest interactive user password file must be absolute",
    );
  }
  return passwordPath;
}

async function readBaselineInteractiveUserPassword(
  contract: BaselineContract,
): Promise<string> {
  const password = (
    await readFile(baselineInteractiveUserPasswordPath(contract), "utf8")
  ).replace(/\r?\n$/, "");
  if (password.length === 0) {
    throw new Error("baseline interactive user password file is empty");
  }
  return password;
}

function fixtureIdentityFromRaw(raw: string): {
  schemaVersion: string;
  sha256: string;
} {
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

async function loadFixtureDocument(): Promise<{
  fixture: {
    schemaVersion: unknown;
    products: Array<Record<string, unknown>>;
    slots: Array<Record<string, unknown>>;
    source?: unknown;
  };
  identity: ReturnType<typeof fixtureIdentityFromRaw>;
}> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw) as {
    schemaVersion?: unknown;
    products?: unknown;
  };
  if (
    fixture.schemaVersion !== "vem-local-testbed-catalog/v1" ||
    !Array.isArray(fixture.products)
  ) {
    throw new Error("local testbed catalog fixture is invalid");
  }
  const products = Array.isArray(fixture.products)
    ? (fixture.products as Array<Record<string, unknown>>)
    : [];
  const rows = new Set(products.map((product) => product.sourceRow));
  if (fixture.products.length !== 44 || rows.size !== fixture.products.length) {
    throw new Error(
      "local testbed catalog must contain the 44 normalized spreadsheet rows",
    );
  }
  return {
    fixture: fixture as {
      schemaVersion: unknown;
      products: Array<Record<string, unknown>>;
      slots: Array<Record<string, unknown>>;
      source?: unknown;
    },
    identity: fixtureIdentityFromRaw(raw),
  };
}

function commandLine(
  command: string,
  args: string[],
  extra: Record<string, unknown> = {},
): CommandStep {
  return { command, args: args.map(String), ...extra } as CommandStep;
}

function renderNodeExecutable(command: string): string {
  if (!["node", "nodejs"].includes(basename(command))) return command;
  if (!isAbsolute(command) || existsSync(command)) return command;
  return process.execPath;
}

function runtimeBaseIdentity(contract: BaselineContract): string {
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

function runtimeTargetIdentity(contract: BaselineContract): string {
  return `vm-target://${String(contract.releaseId).toLowerCase()}`;
}

function baselineContractDigest(contract: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
}

function workflowIdentity(
  options: ReconstructOptions,
  contract: BaselineContract,
): Record<string, unknown> {
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

function parseJsonLine(stdout: unknown, label: string): unknown {
  const trimmed = String(stdout ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} did not emit JSON`);
  }
  const lastLine = trimmed.split(/\r?\n/).at(-1);
  if (lastLine === undefined) {
    throw new Error(`${label} emitted malformed JSON`);
  }
  try {
    return JSON.parse(lastLine);
  } catch {
    throw new Error(`${label} emitted malformed JSON`);
  }
}

interface ReconstructOptions {
  command: string;
  workspace: string;
  stateRoot: string;
  baselineContract: string;
  hostPrivateAddress: string;
  out: string;
  dryRun: boolean;
  runId: string;
  mode?: string;
}

interface CommandStep {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  [key: string]: unknown;
}

function renderPublishedCommand(
  command: string[],
  options: ReconstructOptions,
  contract: BaselineContract,
): CommandStep {
  const guest = contract.testbed?.guest ?? {};
  const replacements: Record<string, string> = {
    repository: options.workspace,
    runId: options.runId,
    hostPrivateAddress: options.hostPrivateAddress,
    systemPath: String(contract.artifacts?.systemPath ?? ""),
    cachePath: String(contract.artifacts?.cachePath ?? ""),
    domainXmlPath: String(contract.artifacts?.domainXmlPath ?? ""),
    guestHost: String(guest.host ?? ""),
    guestUser: String(guest.user ?? ""),
    identityFile: String(guest.identityFile ?? ""),
    knownHostsFile: String(guest.knownHostsFile ?? ""),
    guestStagingPath: String(guest.stagingPath ?? ""),
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
  const executable = rendered[0];
  if (executable === undefined) {
    throw new Error("baseline testbed command is empty");
  }
  return commandLine(renderNodeExecutable(executable), rendered.slice(1));
}

function backendComposeFile(options: ReconstructOptions): string {
  return join(options.workspace, "apps/service-api/docker-compose.yml");
}

function backendComposeEnvFile(options: ReconstructOptions): string {
  return join(options.stateRoot, "backend.compose.env");
}

function backendComposeOverrideFile(options: ReconstructOptions): string {
  return join(options.stateRoot, "backend.compose.override.yml");
}

function quoteComposeEnv(value: unknown): string {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

export function buildBackendComposeEnvironment(
  options: ReconstructOptions,
): Record<string, string> {
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

function containerStatePath(...parts: string[]): string {
  return [SERVICE_API_CONTAINER_STATE_ROOT, ...parts].join("/");
}

export function buildComposeServiceApiEnvironment(
  options: ReconstructOptions,
): Record<string, string> {
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

export function renderBackendComposeEnv(options: ReconstructOptions): string {
  return `${Object.entries(buildBackendComposeEnvironment(options))
    .map(([name, value]) => `${name}=${quoteComposeEnv(value)}`)
    .join("\n")}\n`;
}

function yamlString(value: unknown): string {
  return JSON.stringify(String(value));
}

function renderYamlEnvironment(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `      ${name}: ${yamlString(value)}`)
    .join("\n");
}

export function renderBackendComposeOverride(
  options: ReconstructOptions,
): string {
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

export async function writeBackendComposeFiles(
  options: ReconstructOptions,
): Promise<void> {
  await Promise.all([
    writeFile(backendComposeEnvFile(options), renderBackendComposeEnv(options)),
    writeFile(
      backendComposeOverrideFile(options),
      renderBackendComposeOverride(options),
    ),
  ]);
}

export function buildBackendComposeCommand(
  options: ReconstructOptions,
  args: string[],
): CommandStep {
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

function buildLegacyBackendResourceCleanupCommand(): CommandStep {
  return commandLine("sh", [
    "-c",
    [
      `docker rm -f ${SERVICE_NAMES.postgres} ${SERVICE_NAMES.mqtt} >/dev/null 2>&1 || true`,
      `docker volume rm -f ${VOLUME_NAMES.postgres} ${VOLUME_NAMES.mqtt} >/dev/null 2>&1 || true`,
    ].join("; "),
  ]);
}

export function buildReconstructionPlan(
  options: ReconstructOptions,
  contract: BaselineContract,
): CommandStep[] {
  const state = options.stateRoot;
  const binding = contract.testbed ?? {};
  const guest = binding.guest ?? {};
  const sshArgs = [
    "-i",
    String(guest.identityFile),
    "-o",
    `UserKnownHostsFile=${String(guest.knownHostsFile)}`,
    `${String(guest.user)}@${String(guest.host)}`,
  ];
  return [
    buildBackendComposeCommand(options, [
      "down",
      "--remove-orphans",
      "--volumes",
    ]),
    buildLegacyBackendResourceCleanupCommand(),
    renderPublishedCommand(
      binding.reconstructCommand as string[],
      options,
      contract,
    ),
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
      `powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${String(guest.stagingPath)}') | Out-Null\"`,
    ]),
    commandLine("scp", [
      "-i",
      String(guest.identityFile),
      "-o",
      `UserKnownHostsFile=${String(guest.knownHostsFile)}`,
      join(state, "guest-input.json"),
      `${String(guest.user)}@${String(guest.host)}:${String(guest.stagingPath)}`,
    ]),
    (() => {
      const guestAdmission = renderPublishedCommand(
        binding.admitGuestCommand as string[],
        options,
        contract,
      );
      const guestAdmissionCommand = guestAdmission.command as string;
      const guestAdmissionArgs = guestAdmission.args as string[];
      return commandLine(guestAdmissionCommand, guestAdmissionArgs);
    })(),
  ];
}

async function sourceFilesUnder(
  root: string,
  relativeDirectory: string,
  listDirectory: (
    path: string,
    options: { withFileTypes: true },
  ) => Promise<Array<import("node:fs").Dirent>>,
): Promise<string[]> {
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

async function buildDirectoryIdentity(
  workspace: string,
  relativeDirectory: string,
): Promise<{ byteSize: number; fileCount: number; sha256: string }> {
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

async function observeAdminUiDelivery(indexBytes: Buffer): Promise<unknown> {
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
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
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
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  }
}

export async function buildBackendAcceptanceIdentity(
  workspace: unknown,
  health: { database?: unknown; mqtt?: unknown },
): Promise<Record<string, unknown>> {
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
  workspace: unknown,
  {
    listDirectory = readdir,
    readSource = readFile,
  }: {
    listDirectory?: (
      path: string,
      options: { withFileTypes: true },
    ) => Promise<Array<import("node:fs").Dirent>>;
    readSource?: (path: string) => Promise<Uint8Array>;
  } = {},
): Promise<string> {
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

export function lowerControllerSimCacheLayout(
  options: ReconstructOptions,
  sourceDigest: unknown,
): {
  sourceDigest: string;
  root: string;
  targetDirectory: string;
  binaryPath: string;
  successMarkerPath: string;
} {
  if (!/^[a-f0-9]{64}$/.test(String(sourceDigest ?? ""))) {
    throw new Error(
      "lower-controller simulator source digest must be a SHA-256 hex string",
    );
  }
  const resolvedDigest = String(sourceDigest ?? "");
  const root = join(
    absolute(options.stateRoot, "stateRoot"),
    HOST_SIMULATOR_CACHE_DIRECTORY,
    resolvedDigest,
  );
  const targetDirectory = join(root, "target");
  return {
    sourceDigest: resolvedDigest,
    root,
    targetDirectory,
    binaryPath: join(targetDirectory, "debug", "lower-controller-sim"),
    successMarkerPath: join(root, "build-success.json"),
  };
}

function isValidCacheDigest(value: unknown): boolean {
  return LOWER_CONTROLLER_SIM_CACHE_DIRECTORY_NAME.test(String(value ?? ""));
}

async function removeOutdatedLowerControllerSimCaches({
  layout,
  stateRoot,
  listDirectory = readdir,
  removeDirectory = rm,
}: {
  layout: ReturnType<typeof lowerControllerSimCacheLayout>;
  stateRoot: unknown;
  listDirectory?: (
    path: string,
    options: { withFileTypes: true },
  ) => Promise<Array<import("node:fs").Dirent>>;
  removeDirectory?: typeof rm;
}): Promise<void> {
  const cacheRoot = join(
    absolute(stateRoot, "stateRoot"),
    HOST_SIMULATOR_CACHE_DIRECTORY,
  );
  try {
    await access(cacheRoot, constants.F_OK);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
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
}: {
  options: ReconstructOptions;
  sourceDigest?: string;
  pruneCaches?: boolean;
  dependencies?: {
    listDirectory?: (
      path: string,
      options: { withFileTypes: true },
    ) => Promise<Array<import("node:fs").Dirent>>;
    removeDirectory?: typeof rm;
    isExecutable?: (path: string) => Promise<boolean>;
    markerPresent?: (path: string) => Promise<boolean>;
    ensureDirectory?: typeof mkdir;
    runCommand?: typeof run;
    publishMarker?: typeof writeFile;
  };
}): Promise<Record<string, unknown>> {
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

export function buildHostLocalServiceApiEnvironment(
  options: ReconstructOptions,
): Record<string, string> {
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
    PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH: String(createOrderGate.statePath),
    PAYMENT_MOCK_PROVIDER_QUERY_FAULT_PATH: String(queryFault.statePath),
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
  explicitEnvironment: Record<string, unknown>,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of COMMAND_ENV_PASSTHROUGH) {
    const value = baseEnvironment[name];
    if (typeof value === "string" && value.length > 0) merged[name] = value;
  }
  const mergedExplicit: Record<string, string> = {};
  for (const [name, value] of Object.entries(explicitEnvironment)) {
    mergedExplicit[name] = String(value);
  }
  return { ...merged, ...mergedExplicit };
}

export function buildMigrationEnvironment(
  options: ReconstructOptions,
  {
    baseEnvironment = process.env,
  }: { baseEnvironment?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
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

export function buildServiceApiComposePlan(
  options: ReconstructOptions,
): CommandStep[] {
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

function baselineDomainName(contract: BaselineContract): string {
  const command = contract.testbed?.reconstructCommand;
  const commandParts = Array.isArray(command) ? command : [];
  const index = commandParts.indexOf("--domain-name");
  return required(
    index >= 0 ? commandParts[index + 1] : null,
    "baseline domain name",
  );
}

export function buildHostControlPlaneUnitPlan(
  options: ReconstructOptions,
  contract: BaselineContract,
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
): CommandStep[] {
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

function baselineLibvirtUri(contract: BaselineContract): string {
  const command = contract.testbed?.reconstructCommand;
  const commandParts = Array.isArray(command) ? command : [];
  const index = commandParts.indexOf("--libvirt-uri");
  return required(
    index >= 0 ? commandParts[index + 1] : null,
    "baseline libvirt uri",
  );
}

export function buildHeadlessVncActivatorUnitPlan(
  options: ReconstructOptions,
  contract: BaselineContract,
): CommandStep[] {
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

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: import("node:child_process").StdioOptions;
  } = {},
): Promise<ReturnType<typeof spawn>> {
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

function runCapture(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
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

export function interpretServiceApiJournalCapture(input: {
  ok?: unknown;
  stdout?: unknown;
  error?: unknown;
}): { kind: "unavailable" | "journal"; text: string } {
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

async function waitForPostgres(): Promise<void> {
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

async function requestJson(
  baseUrl: unknown,
  path: unknown,
  options: { method?: unknown; token?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: String(options.method ?? "GET"),
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = (await response.json()) as { code?: unknown; data?: unknown };
  if (!response.ok || payload?.code !== 0) {
    throw new Error(
      `${options.method ?? "GET"} ${path} failed: ${JSON.stringify(payload)}`,
    );
  }
  return payload.data;
}

function installationFixturePath(
  fixturePath: unknown = process.env[INSTALLATION_ALIPAY_SANDBOX_FIXTURE_ENV],
): string {
  if (typeof fixturePath !== "string" || fixturePath.trim() === "") {
    throw new Error(
      `${INSTALLATION_ALIPAY_SANDBOX_FIXTURE_ENV} must identify the host-owned Alipay sandbox fixture`,
    );
  }
  return absolute(fixturePath, INSTALLATION_ALIPAY_SANDBOX_FIXTURE_ENV);
}

function validateAlipayFixtureChannels(fixture: {
  channelPolicy?: { channels?: unknown };
}): void {
  const channels = fixture.channelPolicy?.channels;
  if (
    !Array.isArray(channels) ||
    !["qr_code:alipay", "payment_code:alipay"].every((channelKey) =>
      channels.some(
        (channel: { channelKey?: unknown; enabled?: unknown }) =>
          channel.channelKey === channelKey && channel.enabled === true,
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
}: {
  baseUrl: unknown;
  fixturePath?: unknown;
  readFixture?: (path: string) => Promise<unknown>;
  request?: (
    baseUrl: unknown,
    path: unknown,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const resolvedFixturePath = installationFixturePath(fixturePath);
  const fixture = validateInstallationOwnedAlipaySandboxFixture(
    (await readFixture(resolvedFixturePath)) as Record<string, unknown> | null,
  );
  const providerConfig = (fixture.providerConfig ?? {}) as Record<
    string,
    unknown
  >;
  const channelPolicy = (fixture.channelPolicy ?? {}) as {
    channels?: unknown;
  };
  validateAlipayFixtureChannels(fixture);
  const login = (await request(baseUrl, "/auth/login", {
    method: "POST",
    body: {
      username: LOCAL_TESTBED_ADMIN_USERNAME,
      password: LOCAL_TESTBED_ADMIN_PASSWORD,
    },
  })) as { accessToken?: unknown } | null;
  const token = required(
    login?.accessToken,
    "host preparation admin access token",
  );
  const providers = (await request(baseUrl, "/payments/providers", {
    token,
  })) as Array<{ code?: unknown; id?: unknown }> | null;
  const alipay = Array.isArray(providers)
    ? providers.find((provider) => provider?.code === "alipay")
    : null;
  const providerId = required(alipay?.id, "Alipay provider id");
  await request(baseUrl, `/payments/providers/${providerId}`, {
    method: "PATCH",
    token,
    body: { status: "enabled" },
  });
  const config = (await request(baseUrl, "/payments/provider-configs", {
    method: "POST",
    token,
    body: providerConfig,
  })) as { id?: unknown } | null;
  await request(baseUrl, "/payments/channel-policy", {
    method: "PUT",
    token,
    body: channelPolicy,
  });
  const publicConfig = (providerConfig.publicConfigJson ?? {}) as {
    mode?: unknown;
    gatewayUrl?: unknown;
    keyType?: unknown;
  };
  const providerConfigId = required(config?.id, "Alipay provider config id");
  const configured = (await request(baseUrl, "/payments/provider-configs", {
    token,
  })) as Array<{
    id?: unknown;
    providerCode?: unknown;
    publicConfigJson?: {
      mode?: unknown;
      gatewayUrl?: unknown;
      keyType?: unknown;
    };
  }> | null;
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
      appId: required(providerConfig.appId, "Alipay appId"),
      merchantNo: required(providerConfig.merchantNo, "Alipay merchantNo"),
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

function testbedTryOnGarmentAsset(template = "tshirt_short_sleeve"): {
  fileName: string;
  contentType: string;
  buffer: Buffer;
} {
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

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
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

function createRgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number, width: number, height: number) => number[],
): Buffer {
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

function createProductFixturePng({
  background,
  accent,
}: {
  background: number[];
  accent: number[];
}): Buffer {
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
  // 现场确认过的透明黑色短袖同时服务真实试衣与 T 恤商品展示；VM 不再把
  // RGB 几何探针当作顾客可见成衣。长袖仍只保留其独有的模板覆盖。
  tryOnGarment: FIELD_TRY_ON_GARMENT,
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
    T恤: FIELD_TRY_ON_GARMENT,
  }),
});

const TESTBED_PRODUCT_DISPLAY_IMAGE_FIXTURES = Object.freeze({
  袜子: "socks",
  内裤: "underwear",
  T恤: "tshirts",
});

function testbedProductDisplayImageAsset(category: string): {
  fileName: string;
  contentType: string;
  buffer: Buffer;
} {
  const fixtureKey = (
    TESTBED_PRODUCT_DISPLAY_IMAGE_FIXTURES as Record<string, string>
  )[category];
  const buffer = (
    TESTBED_MEDIA_FIXTURES.productDisplayImages as Record<string, Buffer>
  )[category];
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

async function uploadMultipartFile(
  baseUrl: unknown,
  path: unknown,
  options: Record<string, unknown>,
): Promise<unknown> {
  const buffer = options.buffer as Buffer;
  const contentType = String(options.contentType);
  const fileName = String(options.fileName);
  const token = options.token;
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(buffer)], { type: contentType }),
    fileName,
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });
  const payload = (await response.json()) as { code?: unknown; data?: unknown };
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`POST ${path} failed: ${JSON.stringify(payload)}`);
  }
  return payload.data;
}

async function waitForApi(
  baseUrl: unknown,
): Promise<{ database: string; mqtt: string }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const payload = (await response.json()) as {
        data?: { database?: unknown; mqtt?: unknown };
      };
      if (
        response.ok &&
        payload?.data?.database === "ok" &&
        payload?.data?.mqtt === "connected"
      ) {
        return {
          database: String(payload.data?.database),
          mqtt: String(payload.data?.mqtt),
        };
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("local testbed Service API did not become ready");
}

async function waitForHostControlPlane(
  endpoint: unknown,
  token: unknown,
): Promise<void> {
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

async function serviceApiFailure(
  error: unknown,
  options: ReconstructOptions | null = null,
): Promise<Error> {
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
      const result = await runCapture(
        command.command as string,
        command.args as string[],
      );
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
  return new Error(`${errorMessage(error)}\n${suffix}`);
}

export function guestSourceGarmentPublicPath(asset: {
  id?: unknown;
  managedReference?: unknown;
}): string {
  if (typeof asset?.id !== "string" || asset.id.length === 0) {
    throw new Error("try-on garment upload asset id is required");
  }
  if (
    typeof asset.managedReference !== "string" ||
    asset.managedReference.length === 0
  ) {
    throw new Error("try-on garment upload managedReference is required");
  }
  const expectedPath = `/api/media-assets/${asset.id}/content`;
  if (asset.managedReference !== expectedPath) {
    throw new Error("try-on garment upload managedReference is invalid");
  }
  return expectedPath;
}

export function planogramVersionForSlots(
  slots: readonly Record<string, unknown>[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(slots))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `LOCAL-TESTBED-${digest}`;
}

export async function seedThroughSupportedApis({
  baseUrl,
  fixture,
  hostPrivateAddress,
  request = requestJson,
  upload = uploadMultipartFile,
}: {
  baseUrl: unknown;
  fixture: {
    products: Array<Record<string, unknown>>;
    slots: Array<Record<string, unknown>>;
  };
  hostPrivateAddress: unknown;
  request?: (
    baseUrl: unknown,
    path: unknown,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  upload?: (
    baseUrl: unknown,
    path: unknown,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const asRecordArray = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  const login = asRecord(
    await request(baseUrl, "/auth/login", {
      method: "POST",
      body: {
        username: LOCAL_TESTBED_ADMIN_USERNAME,
        password: LOCAL_TESTBED_ADMIN_PASSWORD,
      },
    }),
  );
  const token = login.accessToken;
  const tryOnGarmentAsset = asRecord(
    await upload(baseUrl, "/media-assets/try-on-garments", {
      token,
      ...testbedTryOnGarmentAsset(),
    }),
  );
  const longTryOnGarmentAsset = asRecord(
    await upload(baseUrl, "/media-assets/try-on-garments", {
      token,
      ...testbedTryOnGarmentAsset("tshirt_long_sleeve"),
    }),
  );
  const productDisplayAssetsByCategory = new Map<
    string,
    Record<string, unknown>
  >();
  for (const category of Object.keys(TESTBED_PRODUCT_DISPLAY_IMAGE_FIXTURES)) {
    productDisplayAssetsByCategory.set(
      category,
      asRecord(
        await upload(baseUrl, "/media-assets/product-display-images", {
          token,
          ...testbedProductDisplayImageAsset(category),
        }),
      ),
    );
  }
  interface SeededProduct {
    sourceRow?: unknown;
    category?: unknown;
    name?: unknown;
    size?: unknown;
    product: Record<string, unknown>;
    variant: Record<string, unknown>;
    displayImageAsset: Record<string, unknown>;
  }
  const products: SeededProduct[] = [];
  for (const [index, entry] of fixture.products.entries()) {
    const displayImageAsset = productDisplayAssetsByCategory.get(
      String(entry.category),
    );
    if (!displayImageAsset) {
      throw new Error(
        `local testbed fixture product category has no display image asset: ${entry.category}`,
      );
    }
    const product = asRecord(
      await request(baseUrl, "/products", {
        method: "POST",
        token,
        body: {
          name: entry.name,
          description: `${entry.category} normalized testbed fixture`,
          displayImageMediaAssetId: displayImageAsset.id,
          status: "active",
          sortOrder: index,
        },
      }),
    );
    const variant = asRecord(
      await request(baseUrl, "/product-variants", {
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
      }),
    );
    products.push({
      ...entry,
      product,
      variant,
      displayImageAsset,
    });
  }
  const providers = asRecordArray(
    await request(baseUrl, "/payments/providers", { token }),
  );
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
  const machine = asRecord(
    await request(baseUrl, "/machines", {
      method: "POST",
      token,
      body: {
        code: "VEM-TESTBED-LOCAL",
        name: "Local Windows Runtime Testbed",
        locationLabel: "testbed host",
      },
    }),
  );
  await request(baseUrl, `/machines/${machine.id}`, {
    method: "PATCH",
    token,
    body: { status: "online" },
  });
  const seededSlots: Array<{
    slot: Record<string, unknown>;
    product: SeededProduct;
    machineSlot: Record<string, unknown>;
    inventory: Record<string, unknown>;
  }> = [];
  for (const fixtureSlot of fixture.slots) {
    const slot: Record<string, unknown> = {
      ...fixtureSlot,
      onHandQty: Math.min(
        Number(fixtureSlot.onHandQty),
        Number(fixtureSlot.capacity),
      ),
    };
    const machineSlot = asRecord(
      await request(baseUrl, `/machines/${machine.id}/slots`, {
        method: "POST",
        token,
        body: {
          rowNo: slot.rowNo,
          cellNo: slot.cellNo,
          capacity: slot.capacity,
          status: "enabled",
        },
      }),
    );
    const product = products.find((item) => item.sourceRow === slot.sourceRow);
    if (product === undefined) {
      throw new Error(
        `local testbed fixture slot has no product: ${String(slot.sourceRow)}`,
      );
    }
    const inventory = asRecord(
      await request(baseUrl, "/inventories", {
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
      }),
    );
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
    const variant = asRecord(
      await request(baseUrl, "/product-variants", {
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
      }),
    );
    const machineSlot = asRecord(
      await request(baseUrl, `/machines/${machine.id}/slots`, {
        method: "POST",
        token,
        body: {
          rowNo: definition.rowNo,
          cellNo: definition.cellNo,
          capacity: recommendationBase.slot.capacity,
          status: "enabled",
        },
      }),
    );
    const inventory = asRecord(
      await request(baseUrl, "/inventories", {
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
      }),
    );
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
  const createGarment = async (
    sourceMediaAssetId: unknown,
    template: unknown,
    colorLabel: unknown,
  ): Promise<Record<string, unknown>> => {
    const draft = asRecord(
      await request(baseUrl, "/try-on-garments", {
        method: "POST",
        token,
        body: {
          productId: recommendationBase.product.product.id,
          colorLabel,
          sourceMediaAssetId,
          template,
        },
      }),
    );
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
  const tryOnGarment = asRecord(
    await request(
      baseUrl,
      `/try-on-garments/${shortDraft.id}/variant-associations`,
      { method: "PUT", token, body: { variantIds: [shortVariant.variantId] } },
    ),
  );
  const longTryOnGarment = asRecord(
    await request(
      baseUrl,
      `/try-on-garments/${longDraft.id}/variant-associations`,
      { method: "PUT", token, body: { variantIds: [longVariant.variantId] } },
    ),
  );
  const publishedSlots = planogramSeededSlots.map(
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
  );
  const planogramVersion = planogramVersionForSlots(publishedSlots);
  await request(baseUrl, `/machines/${machine.id}/planogram-versions`, {
    method: "POST",
    token,
    body: {
      planogramVersion,
      slots: publishedSlots,
    },
  });
  const claim = asRecord(
    await request(baseUrl, `/machines/${machine.id}/claim-codes`, {
      method: "POST",
      token,
      body: { purpose: "first_claim" },
    }),
  );
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
      sourceGarment: {
        // Service API 在 host loopback 上 seed；guest 只能按其 Runtime Bootstrap
        // 的私网 origin 解析这个相对公共资源路径。
        publicPath: guestSourceGarmentPublicPath(tryOnGarmentAsset),
        assetId: tryOnGarmentAsset.id,
        digest: `sha256:${createHash("sha256").update(testbedTryOnGarmentAsset().buffer).digest("hex")}`,
        contentType: "image/png",
        byteSize: testbedTryOnGarmentAsset().buffer.byteLength,
        template: "tshirt_short_sleeve",
        width: 1158,
        height: 1253,
      },
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

async function stopServiceApiUnit(options: ReconstructOptions): Promise<void> {
  const stop = buildServiceApiComposePlan(options)[0];
  await run(stop.command as string, stop.args as string[], {
    stdio: "ignore",
  }).catch(() => undefined);
}

async function startServiceApiUnit(options: ReconstructOptions): Promise<void> {
  const start = buildServiceApiComposePlan(options).at(-1);
  if (start === undefined) throw new Error("service API start plan is empty");
  await run(start.command as string, start.args as string[], {
    cwd: options.workspace,
  });
}

async function stopHostControlPlaneUnit(
  options: ReconstructOptions,
  contract: BaselineContract,
): Promise<void> {
  const [stop, reset] = buildHostControlPlaneUnitPlan(options, contract);
  await run(stop.command as string, stop.args as string[], {
    stdio: "ignore",
  }).catch(() => undefined);
  await run(reset.command as string, reset.args as string[], {
    stdio: "ignore",
  }).catch(() => undefined);
}

async function startHostControlPlaneUnit(
  options: ReconstructOptions,
  contract: BaselineContract,
  lowerControllerSimPath: string,
  token?: unknown,
): Promise<void> {
  const start = buildHostControlPlaneUnitPlan(options, contract, {
    lowerControllerSimPath,
    ...(token ? { token: String(token) } : {}),
  }).at(-1);
  if (start === undefined) {
    throw new Error("host control plane start plan is empty");
  }
  await run(start.command as string, start.args as string[], {
    cwd: options.workspace,
  });
}

async function stopHeadlessVncActivatorUnit(
  options: ReconstructOptions,
  contract: BaselineContract,
): Promise<void> {
  const [stop, reset] = buildHeadlessVncActivatorUnitPlan(options, contract);
  await run(stop.command as string, stop.args as string[], {
    stdio: "ignore",
  }).catch(() => undefined);
  await run(reset.command as string, reset.args as string[], {
    stdio: "ignore",
  }).catch(() => undefined);
}

async function startHeadlessVncActivatorUnit(
  options: ReconstructOptions,
  contract: BaselineContract,
): Promise<void> {
  const start = buildHeadlessVncActivatorUnitPlan(options, contract).at(-1);
  if (start === undefined) {
    throw new Error("headless VNC activator start plan is empty");
  }
  await run(start.command as string, start.args as string[], {
    cwd: options.workspace,
  });
}

export function buildRefreshHostRuntimePlan(
  options: ReconstructOptions,
): CommandStep[] {
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
  input: unknown,
  options: ReconstructOptions,
  expectedFixtureIdentity: { sha256?: unknown },
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("existing guest input must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== "vem-local-testbed-guest-input/v1") {
    throw new Error("existing guest input schemaVersion is invalid");
  }
  if (
    typeof record.machineCode !== "string" ||
    typeof record.claimCode !== "string" ||
    !record.fixtureAllocation ||
    typeof record.fixtureAllocation !== "object" ||
    !record.hostControlPlane ||
    typeof record.hostControlPlane !== "object" ||
    typeof (record.hostControlPlane as Record<string, unknown>).token !==
      "string" ||
    String((record.hostControlPlane as Record<string, unknown>).token)
      .length === 0
  ) {
    throw new Error(
      "existing guest input must retain machine, claim, fixture, and host control plane token",
    );
  }
  const endpoint = `http://${options.hostPrivateAddress}:${HOST_CONTROL_PLANE_PORT}`;
  if (
    (record.hostControlPlane as Record<string, unknown>).endpoint !== endpoint
  ) {
    throw new Error(
      "existing guest input host control plane endpoint is invalid",
    );
  }
  if (
    expectedFixtureIdentity &&
    (record.fixtureIdentity as { sha256?: unknown } | undefined)?.sha256 !==
      expectedFixtureIdentity.sha256
  ) {
    throw new Error("existing guest input fixture identity is stale");
  }
  return record;
}

export function refreshGuestInputForRun(
  input: Record<string, unknown>,
  runId: unknown,
  paymentProvider?: unknown,
  interactiveUserPassword?: unknown,
): Record<string, unknown> {
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
}: {
  input: Record<string, unknown>;
  runId: unknown;
  baseUrl: unknown;
  preparePaymentProvider?: typeof prepareInstallationOwnedPaymentProvider;
}): Promise<Record<string, unknown>> {
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
}: {
  input: Record<string, unknown>;
  runId?: unknown;
  baseUrl: unknown;
  fixture: {
    products: Array<Record<string, unknown>>;
    slots: Array<Record<string, unknown>>;
  };
  hostPrivateAddress: unknown;
  request?: (
    baseUrl: unknown,
    path: unknown,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  upload?: typeof uploadMultipartFile;
  seedPlatform?: typeof seedThroughSupportedApis;
}): Promise<Record<string, unknown>> {
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const login = asRecord(
    await request(baseUrl, "/auth/login", {
      method: "POST",
      body: {
        username: LOCAL_TESTBED_ADMIN_USERNAME,
        password: LOCAL_TESTBED_ADMIN_PASSWORD,
      },
    }),
  );
  const token = login.accessToken;
  const machinesPage = asRecord(
    await request(baseUrl, "/machines?page=1&pageSize=100", {
      token,
    }),
  );
  const existingMachine = (
    Array.isArray(machinesPage.items)
      ? (machinesPage.items as Array<Record<string, unknown>>)
      : []
  ).find((machine) => machine.code === input.machineCode);
  if (existingMachine) return input;

  const seeded = asRecord(
    await seedPlatform({
      baseUrl,
      fixture,
      hostPrivateAddress,
      request,
      upload,
    }),
  );
  return {
    ...input,
    fixtureAllocation: allocateFullWorkflowFixtures(
      seeded.slots as Array<Record<string, unknown>>,
    ),
    claimCode: (seeded.claim as Record<string, unknown>).claimCode,
    machineCode: (seeded.machine as Record<string, unknown>).code,
    planogramVersion: seeded.planogramVersion,
    visionAcceptance: seeded.visionAcceptance,
  };
}

async function stageExistingGuestInput(
  options: ReconstructOptions,
  contract: BaselineContract,
): Promise<void> {
  const guest = contract.testbed?.guest ?? {};
  const ssh = [
    "-i",
    String(guest.identityFile),
    "-o",
    `UserKnownHostsFile=${String(guest.knownHostsFile)}`,
  ];
  await run("ssh", [
    ...ssh,
    `${String(guest.user)}@${String(guest.host)}`,
    `powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${String(guest.stagingPath)}') | Out-Null\"`,
  ]);
  await run("scp", [
    ...ssh,
    join(options.stateRoot, "guest-input.json"),
    `${String(guest.user)}@${String(guest.host)}:${String(guest.stagingPath)}`,
  ]);
}

export async function refreshHostRuntime(
  options: ReconstructOptions,
): Promise<Record<string, unknown>> {
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
    String(hostSimulator.binaryPath),
    (guestInput.hostControlPlane as Record<string, unknown>).token,
  );
  await waitForHostControlPlane(
    (guestInput.hostControlPlane as Record<string, unknown>).endpoint,
    (guestInput.hostControlPlane as Record<string, unknown>).token,
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
      hostControlPlane: {
        endpoint: (guestInput.hostControlPlane as Record<string, unknown>)
          .endpoint,
      },
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

async function reconstruct(
  options: ReconstructOptions & { mode: string },
): Promise<Record<string, unknown>> {
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
  await mkdir(dirname(String(createOrderGate.statePath)), { recursive: true });
  await writeFile(
    String(createOrderGate.statePath),
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
  await run(plan[0].command, plan[0].args, {
    stdio: "ignore",
  }).catch(() => undefined);
  await run(plan[1].command, plan[1].args, {
    stdio: "ignore",
  }).catch(() => undefined);
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
    ) as Record<string, unknown>;
    await startHeadlessVncActivatorUnit(options, contract);
    await run(plan[3].command, plan[3].args, {
      cwd: options.workspace,
    });
    await waitForPostgres();
    for (const step of plan.slice(4, 6)) {
      await run(step.command, step.args, {
        cwd: options.workspace,
        env: step.env,
      });
    }
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
      String(hostSimulator.binaryPath),
    );
    let seeded: Record<string, unknown>;
    let paymentProvider;
    const interactiveUserPassword =
      await readBaselineInteractiveUserPassword(contract);
    try {
      seeded = (await seedThroughSupportedApis({
        baseUrl: apiBaseUrl,
        fixture,
        hostPrivateAddress: options.hostPrivateAddress,
      })) as Record<string, unknown>;
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
      fixtureAllocation: allocateFullWorkflowFixtures(
        seeded.slots as Array<Record<string, unknown>>,
      ),
      claimCode: (seeded.claim as Record<string, unknown>).claimCode,
      machineCode: (seeded.machine as Record<string, unknown>).code,
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
    for (const step of plan.slice(6, -1)) {
      await run(step.command, step.args, {
        cwd: options.workspace,
      });
    }
    const admitGuest = plan.at(-1);
    if (admitGuest === undefined) {
      throw new Error("host admission plan step is missing");
    }
    const admissionStartedAt = new Date().toISOString();
    const admitHost = await runCapture(admitGuest.command, admitGuest.args, {
      cwd: options.workspace,
    });
    const admissionFinishedAt = new Date().toISOString();
    const admitHostResult = parseJsonLine(
      admitHost.stdout,
      "host admission",
    ) as Record<string, unknown>;
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
        slots: seeded.slots as Array<Record<string, unknown>>,
      },
      guestInput: {
        sha256: `sha256:${createHash("sha256").update(guestInputRaw).digest("hex")}`,
        machineCode: (seeded.machine as Record<string, unknown>).code,
        planogramVersion: seeded.planogramVersion,
        bootstrapPath: String(contract.testbed?.guest?.stagingPath ?? ""),
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
          remote: `${String(contract.testbed?.guest?.user ?? "")}@${String(contract.testbed?.guest?.host ?? "")}`,
          host: String(contract.testbed?.guest?.host ?? ""),
          user: String(contract.testbed?.guest?.user ?? ""),
          identityFile: String(contract.testbed?.guest?.identityFile ?? ""),
          knownHostsFile: String(contract.testbed?.guest?.knownHostsFile ?? ""),
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
      : await reconstruct(options as ReconstructOptions & { mode: string });
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
