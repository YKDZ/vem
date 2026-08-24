#!/usr/bin/env node

import type { Dirent } from "node:fs";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { BusinessCheckDescriptor } from "./business-check-registry.ts";

import {
  BUSINESS_CHECK_REGISTRY,
  selectBusinessChecks,
} from "./business-check-registry.ts";
import { redactSensitiveEvidenceText } from "./failure-evidence-redaction.ts";
import { synthesizeProcessReplayVideos } from "./process-replay-video.ts";

type JsonRecord = Record<string, unknown>;

interface Artifact {
  hostPath: string;
  sha256: string;
  byteSize: number;
  sourceCommit?: string;
  guestPath?: string;
  members?: TransferMember[];
}

interface GuestTransfer extends Artifact {
  guestPath: string;
}

interface TransferMember {
  name: string;
  byteSize: number;
  sha256: string;
}

interface HostConfig extends JsonRecord {
  schemaVersion: string;
  mirrorPath: string;
  workspaceRoot: string;
  stateRoot: string;
  baselineContract: string;
  hostPrivateAddress: string;
  guestSourcePath: string;
  environment: Record<string, string>;
  pathPrepend: string[];
  visionCoreArtifacts: {
    runtimeArchive: Artifact;
    recordedFixtureArchive: Artifact;
  };
}

interface OrchestratorOptions extends JsonRecord {
  command: string;
  configPath: string;
  runId?: string;
  mode?: string;
  commit?: string;
  focus?: string[];
}

interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "ignore" | "pipe";
  detached?: boolean;
  timeoutMs?: number;
  timeoutLabel?: string;
}

interface CaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  timeoutLabel?: string;
}

interface ProcessError extends Error {
  command?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  businessFailure?: boolean;
}

interface VisionCorePreparation {
  guestInput: JsonRecord;
  transfers: Artifact[];
}

interface GuestContract {
  testbed: {
    guest: JsonRecord;
  };
}

const MODES = new Set(["fast", "full", "clear_cache"]);
const TERMINAL = new Set([
  "passed",
  "failed",
  "infrastructure_failed",
  "superseded",
]);
const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);
const STATUS_SCHEMA = "vem-runtime-testbed-run/v1";
const CONFIG_SCHEMA = "vem-runtime-testbed-host/v1";
const GUEST_SETUP_TIMEOUT_MS = 120_000;
const GUEST_TRANSFER_TIMEOUT_MS = 300_000;
const GUEST_TRANSFER_STARTUP_ALLOWANCE_MS = 120_000;
const GUEST_TRANSFER_MIN_BYTES_PER_SECOND = 8 * 1024 * 1024;
const GUEST_TRANSFER_MAX_TIMEOUT_MS = 30 * 60_000;
const GUEST_FAST_EXECUTION_TIMEOUT_MS = 15 * 60_000;
const GUEST_FAST_ADDITIONAL_FOCUS_TIMEOUT_MS = 5 * 60_000;
const GUEST_FULL_EXECUTION_TIMEOUT_MS = 45 * 60_000;
const GUEST_STARTUP_OBSERVATION_TIMEOUT_MS = 10 * 60_000;
const GUEST_REBOOT_DISCONNECT_TIMEOUT_MS = 2 * 60_000;
const GUEST_REBOOT_READY_TIMEOUT_MS = 5 * 60_000;
const GUEST_REBOOT_POLL_MS = 2_000;
const GUEST_REBOOT_PROBE_TIMEOUT_MS = 20_000;
const WINDOWS_REMOTE_COMMAND_MAX_CHARS = 8_000;
const GUEST_ACCEPTANCE_INPUT_CACHE = "D:\\runtime-cache\\v1\\acceptance-inputs";

type GuestStartupPhase =
  | "single"
  | "prepare_reboot"
  | "resume_reboot"
  | "observe_reboot";

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

export function guestAcceptanceExecutionBudget({
  mode,
  focus = [],
  registry = BUSINESS_CHECK_REGISTRY,
}: {
  mode: string;
  focus?: string[];
  registry?: readonly BusinessCheckDescriptor[];
}): {
  timeoutMs: number;
  selectedSets: string[];
  timeoutLabel: string;
} {
  const selected = selectBusinessChecks({ mode, focus, registry });
  const selectedSets = selected.map((descriptor) => descriptor.name);
  let timeoutMs;
  if (mode === "full") {
    timeoutMs = GUEST_FULL_EXECUTION_TIMEOUT_MS;
  } else {
    const additionalSets = selectedSets.length - 1;
    const uncappedTimeoutMs =
      GUEST_FAST_EXECUTION_TIMEOUT_MS +
      additionalSets * GUEST_FAST_ADDITIONAL_FOCUS_TIMEOUT_MS;
    if (selectedSets.length === 0 || !Number.isSafeInteger(uncappedTimeoutMs)) {
      throw new Error(
        `guest acceptance execution budget is invalid: selectedSets=${selectedSets.join(",")}`,
      );
    }
    timeoutMs = Math.min(uncappedTimeoutMs, GUEST_FULL_EXECUTION_TIMEOUT_MS);
  }
  return {
    timeoutMs,
    selectedSets,
    timeoutLabel: `guest acceptance execution; mode=${mode}; budgetMs=${timeoutMs}; selectedSets=${selectedSets.join(",")}`,
  };
}

export function reconstructedAcceptancePasses(
  mode: string,
  focus: string[] = [],
): number {
  return mode === "full" && focus.length === 0 ? 2 : 1;
}

export function additionalStartupRebootObservationOrdinals({
  mode,
  focus = [],
  pass,
}: {
  mode: string;
  focus?: string[];
  pass: number;
}): number[] {
  return mode === "full" && focus.length === 0 && pass === 2
    ? Array.from({ length: 8 }, (_, index) => index + 3)
    : [];
}

export async function collectStartupRebootObservations({
  ordinals,
  observe,
}: {
  ordinals: number[];
  observe: (ordinal: number) => Promise<{ ok: boolean; reportPath: string }>;
}): Promise<{
  ok: boolean;
  reportPaths: string[];
  firstFailureOrdinal: number | null;
}> {
  const reportPaths: string[] = [];
  for (const ordinal of ordinals) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      throw new Error("startup reboot observation ordinal must be positive");
    }
    const result = await observe(ordinal);
    reportPaths.push(required(result.reportPath, "startup observation report"));
    if (!result.ok) {
      return {
        ok: false,
        reportPaths,
        firstFailureOrdinal: ordinal,
      };
    }
  }
  return { ok: true, reportPaths, firstFailureOrdinal: null };
}

export function processReplayGuestDirectory({
  enabled,
  mode,
  pass,
}: {
  enabled: boolean;
  mode: string;
  pass: number;
}): string | null {
  if (!enabled || (mode !== "fast" && mode !== "full")) return null;
  if (!Number.isSafeInteger(pass) || pass < 1) {
    throw new Error("process replay pass must be a positive integer");
  }
  return `C:\\ProgramData\\VEM\\testbed\\process-replay-pass-${pass}`;
}

function artifactFile(
  value: unknown,
  label: string,
  sourceCommit = false,
): Artifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as JsonRecord;
  const expectedKeys = sourceCommit
    ? ["hostPath", "sha256", "byteSize", "sourceCommit"]
    : ["hostPath", "sha256", "byteSize"];
  if (
    Object.keys(record).sort().join("\0") !== expectedKeys.sort().join("\0")
  ) {
    throw new Error(`${label} fields are invalid`);
  }
  const path = absolute(record.hostPath, `${label} hostPath`);
  if (!/^[a-f0-9]{64}$/.test(String(record.sha256 ?? ""))) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
  if (
    !Number.isSafeInteger(record.byteSize) ||
    (record.byteSize as number) <= 0
  ) {
    throw new Error(`${label} byte size is invalid`);
  }
  if (
    sourceCommit &&
    !/^[a-f0-9]{40}$/.test(String(record.sourceCommit ?? ""))
  ) {
    throw new Error(`${label} source commit is invalid`);
  }
  return {
    hostPath: path,
    sha256: String(record.sha256),
    byteSize: record.byteSize as number,
    ...(sourceCommit ? { sourceCommit: String(record.sourceCommit) } : {}),
  };
}

function absolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function option(
  args: string[],
  name: string,
  optional = false,
): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) {
    if (optional) return undefined;
    throw new Error(`--${name} is required`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function repeatableOption(args: string[], name: string): string[] {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    values.push(required(args[index + 1], `--${name}`));
    index += 1;
  }
  return values;
}

export function parseOrchestratorOptions(args: string[]): OrchestratorOptions {
  const command = args[0];
  if (!new Set(["run", "status", "execute"]).has(command)) {
    throw new Error(
      "usage: runtime-testbed-orchestrator.ts run|status --config <path> ...",
    );
  }
  const common = {
    command,
    configPath: absolute(option(args, "config"), "--config"),
  };
  if (command === "status") {
    return { ...common, runId: required(option(args, "run-id"), "--run-id") };
  }
  const mode = option(args, "mode") as string;
  if (!MODES.has(mode))
    throw new Error("--mode must be fast, full, or clear_cache");
  const commit = (option(args, "commit") as string).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("--commit must be a full 40-character Git SHA");
  }
  const focus = repeatableOption(args, "focus");
  if (mode === "clear_cache" && focus.length > 0) {
    throw new Error("--focus is only valid with --mode fast or full");
  }
  return {
    ...common,
    mode,
    commit,
    focus,
    runId: option(args, "run-id", command === "run"),
  };
}

export function validateHostConfig(value: unknown): HostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host config must be an object");
  }
  const config = value as JsonRecord;
  if (config.schemaVersion !== CONFIG_SCHEMA) {
    throw new Error(`host config schemaVersion must be ${CONFIG_SCHEMA}`);
  }
  const hostPrivateAddress = required(
    config.hostPrivateAddress,
    "host config hostPrivateAddress",
  );
  if (isIP(hostPrivateAddress) !== 4 || hostPrivateAddress.startsWith("127.")) {
    throw new Error(
      "host config hostPrivateAddress must be a non-loopback IPv4 address",
    );
  }
  const guestSourcePath = required(
    config.guestSourcePath,
    "host config guestSourcePath",
  );
  if (!/^[A-Za-z]:\\/.test(guestSourcePath)) {
    throw new Error(
      "host config guestSourcePath must be an absolute Windows path",
    );
  }
  const environment = config.environment ?? {};
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.entries(environment).some(
      ([name, entry]) =>
        !/^[A-Z_][A-Z0-9_]*$/i.test(name) || typeof entry !== "string",
    )
  ) {
    throw new Error("host config environment must contain string values");
  }
  const pathPrepend = config.pathPrepend ?? [];
  if (!Array.isArray(pathPrepend)) {
    throw new Error("host config pathPrepend must be an array");
  }
  if (
    !config.visionCoreArtifacts ||
    typeof config.visionCoreArtifacts !== "object" ||
    Array.isArray(config.visionCoreArtifacts) ||
    Object.keys(config.visionCoreArtifacts).sort().join("\0") !==
      ["runtimeArchive", "recordedFixtureArchive"].sort().join("\0")
  ) {
    throw new Error(
      "host config visionCoreArtifacts must contain exact-two artifacts",
    );
  }
  return {
    schemaVersion: CONFIG_SCHEMA,
    mirrorPath: absolute(config.mirrorPath, "host config mirrorPath"),
    workspaceRoot: absolute(config.workspaceRoot, "host config workspaceRoot"),
    stateRoot: absolute(config.stateRoot, "host config stateRoot"),
    baselineContract: absolute(
      config.baselineContract,
      "host config baselineContract",
    ),
    hostPrivateAddress,
    guestSourcePath,
    environment: { ...environment },
    pathPrepend: pathPrepend.map((path) =>
      absolute(path, "host config pathPrepend entry"),
    ),
    visionCoreArtifacts: {
      runtimeArchive: artifactFile(
        (config.visionCoreArtifacts as JsonRecord)?.runtimeArchive,
        "host config visionCoreArtifacts.runtimeArchive",
        true,
      ),
      recordedFixtureArchive: artifactFile(
        (config.visionCoreArtifacts as JsonRecord)?.recordedFixtureArchive,
        "host config visionCoreArtifacts.recordedFixtureArchive",
        true,
      ),
    },
  };
}

function executionEnvironment(config: HostConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...config.environment,
    PATH: [...config.pathPrepend, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(":"),
  };
}

async function loadConfig(path: string): Promise<HostConfig> {
  return validateHostConfig(JSON.parse(await readFile(path, "utf8")));
}

function runProcess(
  command: string,
  args: string[],
  options: ProcessRunOptions = {},
): Promise<{
  code: number;
  signal: NodeJS.Signals | null;
  pid: number | undefined;
}> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    let killTimeout: NodeJS.Timeout | null = null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
      detached: options.detached ?? false,
    });
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    if (
      typeof options.timeoutMs === "number" &&
      Number.isInteger(options.timeoutMs) &&
      options.timeoutMs > 0
    ) {
      timeout = setTimeout(() => {
        const error: ProcessError = new Error(
          `${command} timed out after ${options.timeoutMs}ms${options.timeoutLabel ? ` (${options.timeoutLabel})` : ""}`,
        );
        error.command = command;
        error.exitCode = null;
        error.signal = "SIGTERM";
        error.timedOut = true;
        child.kill("SIGTERM");
        killTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
        rejectOnce(error);
      }, options.timeoutMs);
    }
    child.once("error", rejectOnce);
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (code === 0) resolvePromise({ code, signal, pid: child.pid });
      else {
        const error: ProcessError = new Error(
          `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
        );
        error.command = command;
        error.exitCode = code;
        error.signal = signal;
        reject(error);
      }
    });
  });
}

async function capture(
  command: string,
  args: string[],
  options: CaptureOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timeout: NodeJS.Timeout | undefined =
      typeof options.timeoutMs === "number" &&
      Number.isInteger(options.timeoutMs) &&
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            reject(
              new Error(
                `${command} timed out after ${options.timeoutMs}ms${options.timeoutLabel ? ` (${options.timeoutLabel})` : ""}`,
              ),
            );
          }, options.timeoutMs)
        : undefined;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error: Error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolvePromise();
      else
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
  return { stdout, stderr };
}

function runDirectory(config: HostConfig, runId: string): string {
  return join(config.stateRoot, "runs", runId);
}

function fixtureIdentityForWorkspace(workspace: string): JsonRecord {
  const raw = readFileSync(
    join(workspace, "scripts/testbed/fixtures/local-testbed-catalog.json"),
    "utf8",
  );
  const seedSource = readFileSync(
    join(workspace, "scripts/testbed/local-testbed.ts"),
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

export function createRunId(
  commit: string,
  mode: string,
  now: number = Date.now(),
): string {
  return `RUN-${now}-${commit.slice(0, 12).toUpperCase()}-${mode.toUpperCase()}`;
}

function statusPath(config: HostConfig, runId: string): string {
  return join(runDirectory(config, runId), "status.json");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.tmp`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(pending, path);
}

async function readJson(
  path: string,
  fallback: unknown = null,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function withRequestLock<T>(
  config: HostConfig,
  action: () => Promise<T>,
): Promise<T> {
  const lock = join(config.stateRoot, "scheduler.lock");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lock);
      try {
        return await action();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 25),
      );
    }
  }
  throw new Error("timed out acquiring testbed scheduler lock");
}

function processExists(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 2) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(processGroupId: unknown): boolean {
  if (
    typeof processGroupId !== "number" ||
    !Number.isInteger(processGroupId) ||
    processGroupId < 2
  ) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processGroupExists(processGroupId)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (processGroupExists(processGroupId)) {
    throw new Error(`failed to terminate process group ${processGroupId}`);
  }
}

async function waitForTerminal(
  config: HostConfig,
  runId: string,
): Promise<JsonRecord> {
  while (true) {
    const status = (await readJson(statusPath(config, runId))) as JsonRecord;
    if (!status) throw new Error(`run ${runId} has no canonical status`);
    if (TERMINAL.has(String(status.status))) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

function exitCodeFor(status: JsonRecord): number {
  if (status.status === "passed") return 0;
  if (status.status === "superseded") return 75;
  if (status.status === "failed") return 1;
  return 2;
}

function callerResult(status: JsonRecord): JsonRecord {
  return {
    schemaVersion: "vem-runtime-testbed-caller-result/v1",
    runId: status.runId,
    commit: status.commit,
    mode: status.mode,
    status: status.status,
    statusPath: status.statusPath,
    canonicalCompactArtifactPath: status.compactArtifactPath,
  };
}

async function assertMirrorCommit(
  config: HostConfig,
  commit: string,
): Promise<void> {
  await capture("git", [
    `--git-dir=${config.mirrorPath}`,
    "cat-file",
    "-e",
    `${commit}^{commit}`,
  ]);
}

async function materializeWorkspace(
  config: HostConfig,
  commit: string,
): Promise<string> {
  const workspace = join(config.workspaceRoot, commit);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(config.workspaceRoot, { recursive: true });
  await runProcess("git", [
    `--git-dir=${config.mirrorPath}`,
    "worktree",
    "prune",
  ]);
  await runProcess("git", [
    `--git-dir=${config.mirrorPath}`,
    "worktree",
    "add",
    "--detach",
    workspace,
    commit,
  ]);
  return workspace;
}

function sshArguments(guest: JsonRecord): string[] {
  return [
    "-i",
    String(guest.identityFile),
    "-o",
    `UserKnownHostsFile=${String(guest.knownHostsFile)}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
  ];
}

function scpArguments(guest: JsonRecord): string[] {
  return ["-O", ...sshArguments(guest)];
}

export async function waitForGuestReboot({
  probe,
  sleep = (milliseconds: number) =>
    new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, milliseconds),
    ),
  now = Date.now,
  pollMs = GUEST_REBOOT_POLL_MS,
  disconnectTimeoutMs = GUEST_REBOOT_DISCONNECT_TIMEOUT_MS,
  readyTimeoutMs = GUEST_REBOOT_READY_TIMEOUT_MS,
}: {
  probe: () => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  disconnectTimeoutMs?: number;
  readyTimeoutMs?: number;
}): Promise<void> {
  if (
    ![pollMs, disconnectTimeoutMs, readyTimeoutMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error("guest reboot wait durations must be positive integers");
  }
  const waitForState = async (
    expectedReady: boolean,
    timeoutMs: number,
    failure: string,
  ): Promise<void> => {
    const deadline = now() + timeoutMs;
    while (true) {
      if ((await probe()) === expectedReady) return;
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error(failure);
      await sleep(Math.min(pollMs, remaining));
    }
  };
  await waitForState(
    false,
    disconnectTimeoutMs,
    "Windows guest did not disconnect for the requested reboot",
  );
  await waitForState(
    true,
    readyTimeoutMs,
    "Windows guest SSH did not become ready after reboot",
  );
}

async function rebootGuestAfterOwnerInstall({
  remote,
  ssh,
}: {
  remote: string;
  ssh: string[];
}): Promise<void> {
  try {
    await runProcess(
      "ssh",
      [...ssh, remote, "shutdown.exe", "/r", "/t", "0", "/f"],
      {
        timeoutMs: GUEST_SETUP_TIMEOUT_MS,
        timeoutLabel: "guest reboot request after runtime owner installation",
      },
    );
  } catch (error) {
    const processError = error as ProcessError;
    if (processError.command !== "ssh" || processError.exitCode !== 255) {
      throw error;
    }
  }
  const probe = async (): Promise<boolean> => {
    try {
      await runProcess(
        "ssh",
        [
          ...ssh,
          remote,
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "exit 0",
        ],
        {
          stdio: "ignore",
          timeoutMs: GUEST_REBOOT_PROBE_TIMEOUT_MS,
          timeoutLabel: "guest reboot SSH probe",
        },
      );
      return true;
    } catch {
      return false;
    }
  };
  await waitForGuestReboot({ probe });
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function remotePowerShellCommandLength(script: string): number {
  return [
    "powershell.exe",
    "-NoProfile",
    "-EncodedCommand",
    encodedPowerShell(script),
  ].join(" ").length;
}

function boundedPowerShellChunks(blocks: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n${block}` : block;
    if (
      remotePowerShellCommandLength(candidate) <=
      WINDOWS_REMOTE_COMMAND_MAX_CHARS
    ) {
      current = candidate;
      continue;
    }
    if (
      !current ||
      remotePowerShellCommandLength(block) > WINDOWS_REMOTE_COMMAND_MAX_CHARS
    ) {
      throw new Error("guest input staging command exceeds Windows limit");
    }
    chunks.push(current);
    current = block;
  }
  if (current) chunks.push(current);
  return chunks;
}

function canonicalIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalIdentity);
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalIdentity(record[key])]),
    );
  }
  return value;
}

function visionCoreIdentity(runtime: Artifact, fixture: Artifact): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "vem-runtime-testbed-vision-core-input/v1",
        runtimeArchive: {
          sha256: runtime.sha256,
          byteSize: runtime.byteSize,
          sourceCommit: runtime.sourceCommit,
        },
        recordedFixtureArchive: {
          sha256: fixture.sha256,
          byteSize: fixture.byteSize,
          sourceCommit: fixture.sourceCommit,
        },
      }),
    )
    .digest("hex");
}

async function assertVisionCoreArtifact(
  artifact: Artifact,
  label: string,
): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(artifact.hostPath);
  } catch {
    throw new Error(`${label} host artifact is missing`);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} host artifact must be a regular file`);
  }
  if (entry.size !== artifact.byteSize) {
    throw new Error(`${label} host artifact byte size is invalid`);
  }
  const bytes = await readFile(artifact.hostPath);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error(`${label} host artifact SHA-256 is invalid`);
  }
}

export async function loadVisionCoreArtifacts(
  config: HostConfig,
): Promise<VisionCorePreparation> {
  const runtime = config.visionCoreArtifacts.runtimeArchive;
  const fixture = config.visionCoreArtifacts.recordedFixtureArchive;
  await assertVisionCoreArtifact(runtime, "Vision runtime");
  await assertVisionCoreArtifact(fixture, "recorded Vision fixture");
  const sha256 = visionCoreIdentity(runtime, fixture);
  const identity = {
    sha256,
    runtimeArchive: {
      sha256: runtime.sha256,
      byteSize: runtime.byteSize,
      sourceCommit: runtime.sourceCommit,
    },
    recordedFixtureArchive: {
      sha256: fixture.sha256,
      byteSize: fixture.byteSize,
      sourceCommit: fixture.sourceCommit,
    },
  };
  const root = `${GUEST_ACCEPTANCE_INPUT_CACHE}\\vision-core\\${sha256}`;
  const guestFile = (artifact: Artifact, name: string): string =>
    `${GUEST_ACCEPTANCE_INPUT_CACHE}\\files\\${artifact.sha256}\\${name}`;
  return {
    guestInput: {
      schemaVersion: "vem-local-testbed-vision-core-input/v1",
      inputRoot: root,
      runtimeArchive: guestFile(runtime, "vision-runtime.zip"),
      fixtureArchive: guestFile(fixture, "recorded-fixtures.zip"),
      identity,
    },
    transfers: [
      {
        ...runtime,
        guestPath: guestFile(runtime, "vision-runtime.zip"),
      } as Artifact,
      {
        ...fixture,
        guestPath: guestFile(fixture, "recorded-fixtures.zip"),
      } as Artifact,
    ],
  };
}

export async function materializeVisionCoreArtifactSnapshot(
  config: HostConfig,
  root: string,
  { reuse = false }: { reuse?: boolean } = {},
): Promise<VisionCorePreparation> {
  const preparation = await loadVisionCoreArtifacts(config);
  if (reuse) {
    await Promise.all(
      preparation.transfers.map((transfer) =>
        assertVisionCoreArtifact(transfer, "Vision core artifact"),
      ),
    );
    return preparation;
  }
  const snapshotRoot = resolve(
    root,
    String(recordValue(preparation.guestInput.identity).sha256),
  );
  await mkdir(snapshotRoot, { recursive: true });
  const names = ["vision-runtime.zip", "recorded-fixtures.zip"];
  const transfers: Artifact[] = preparation.transfers.map(
    (transfer: Artifact, index: number) => ({
      ...transfer,
      hostPath: join(snapshotRoot, names[index]),
    }),
  );
  await Promise.all(
    preparation.transfers.map((transfer, index) =>
      copyFile(transfer.hostPath, join(snapshotRoot, names[index])),
    ),
  );
  await Promise.all([
    assertVisionCoreArtifact(transfers[0], "Vision runtime snapshot"),
    assertVisionCoreArtifact(transfers[1], "recorded Vision fixture snapshot"),
  ]);
  return {
    ...preparation,
    transfers,
  };
}

export function identicalVisionCoreArtifactSnapshot(
  left: VisionCorePreparation | null | undefined,
  right: VisionCorePreparation | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    JSON.stringify(left.guestInput.identity) ===
    JSON.stringify(right.guestInput.identity)
  );
}

function powerShellLiteral(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function uniqueGuestTransfers(transfers: Artifact[]): GuestTransfer[] {
  const unique = new Map<string, GuestTransfer>();
  for (const transfer of transfers) {
    const guestPath = String(transfer.guestPath ?? "");
    const previous = unique.get(guestPath);
    if (!previous) {
      unique.set(guestPath, transfer as GuestTransfer);
      continue;
    }
    const identity = ({
      byteSize,
      members,
      sha256,
      sourceCommit,
    }: Artifact): string =>
      JSON.stringify({
        byteSize,
        members: members ?? null,
        sha256,
        sourceCommit: sourceCommit ?? null,
      });
    if (identity(previous) !== identity(transfer)) {
      throw new Error("guest input cache destination identity conflicts");
    }
    unique.set(guestPath, transfer as GuestTransfer);
  }
  return [...unique.values()];
}

function guestTransferByteSize(transfer: GuestTransfer): number {
  if (!transfer.members) {
    if (!Number.isSafeInteger(transfer.byteSize) || transfer.byteSize <= 0) {
      throw new Error(
        `guest input transfer byte size invalid (kind=file, guestPath=${transfer.guestPath}, byteSize=${String(transfer.byteSize)}): expected a positive safe integer`,
      );
    }
    return transfer.byteSize;
  }
  let total = 0;
  for (const member of transfer.members) {
    if (!Number.isSafeInteger(member.byteSize) || member.byteSize <= 0) {
      throw new Error(
        `guest input transfer byte size invalid (kind=directory_member, guestPath=${transfer.guestPath}, member=${member.name}, byteSize=${String(member.byteSize)}): expected a positive safe integer`,
      );
    }
    if (total > Number.MAX_SAFE_INTEGER - member.byteSize) {
      throw new Error(
        `guest input transfer byte size invalid (kind=directory_total, guestPath=${transfer.guestPath}, accumulatedBytes=${total}, nextMemberBytes=${member.byteSize}): sum exceeds Number.MAX_SAFE_INTEGER`,
      );
    }
    total += member.byteSize;
  }
  if (total <= 0) {
    throw new Error(
      `guest input transfer byte size invalid (kind=directory_total, guestPath=${transfer.guestPath}, byteSize=${total}): expected a positive safe integer`,
    );
  }
  return total;
}

function guestTransferTimeout(byteSize: number): number {
  return Math.min(
    GUEST_TRANSFER_MAX_TIMEOUT_MS,
    Math.max(
      GUEST_TRANSFER_TIMEOUT_MS,
      GUEST_TRANSFER_STARTUP_ALLOWANCE_MS +
        Math.ceil((byteSize / GUEST_TRANSFER_MIN_BYTES_PER_SECOND) * 1_000),
    ),
  );
}

function guestInputCacheProbes(transfer: GuestTransfer): string[] {
  const candidate = {
    byteSize: transfer.byteSize,
    guestPath: transfer.guestPath,
    sha256: transfer.sha256,
    ...(transfer.members ? { members: transfer.members } : {}),
  };
  if (transfer.members) {
    return [
      [
        `$candidate = ConvertFrom-Json ${powerShellLiteral(JSON.stringify(candidate))}`,
        "$cacheHit = $false",
        "$root = Get-Item -LiteralPath $candidate.guestPath -Force -ErrorAction SilentlyContinue",
        "if ($null -ne $root -and $root -is [System.IO.DirectoryInfo] -and -not ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {",
        "  $entries = @(Get-ChildItem -LiteralPath $root.FullName -Recurse -Force -ErrorAction SilentlyContinue)",
        "  $files = @($entries | Where-Object { $_ -is [System.IO.FileInfo] })",
        "  $cacheHit = @($entries | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }).Count -eq 0 -and $files.Count -eq @($candidate.members).Count",
        "  foreach ($member in @($candidate.members)) {",
        "    if (-not $cacheHit) { break }",
        "    $memberPath = Join-Path $root.FullName ([string]$member.name).Replace('/', [IO.Path]::DirectorySeparatorChar)",
        "    $entry = Get-Item -LiteralPath $memberPath -Force -ErrorAction SilentlyContinue",
        "    if ($null -eq $entry -or -not ($entry -is [System.IO.FileInfo]) -or ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $entry.Length -ne [Int64]$member.byteSize) { $cacheHit = $false; break }",
        "    $actual = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()",
        "    if ($actual -cne [string]$member.sha256) { $cacheHit = $false; break }",
        "  }",
        "}",
        "@{ cacheHits = @($(if ($cacheHit) { $candidate.guestPath })) } | ConvertTo-Json -Compress",
      ].join("\n"),
    ];
  }
  return [
    [
      `$candidate = ConvertFrom-Json ${powerShellLiteral(JSON.stringify(candidate))}`,
      "$cacheHit = $false",
      "$entry = Get-Item -LiteralPath $candidate.guestPath -Force -ErrorAction SilentlyContinue",
      "if ($null -ne $entry -and $entry -is [System.IO.FileInfo] -and -not ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $entry.Length -eq [Int64]$candidate.byteSize) {",
      "  $actual = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()",
      "  $cacheHit = $actual -ceq $candidate.sha256",
      "}",
      "@{ cacheHits = @($(if ($cacheHit) { $candidate.guestPath })) } | ConvertTo-Json -Compress",
    ].join("\n"),
  ];
}

function parseGuestInputCacheHits(
  output: string,
  transfers: GuestTransfer[],
): Set<string> {
  let value: JsonRecord;
  try {
    value = JSON.parse(output.trim()) as JsonRecord;
  } catch {
    throw new Error("guest input cache probe returned invalid JSON");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "cacheHits" ||
    !Array.isArray(value.cacheHits)
  ) {
    throw new Error("guest input cache probe returned invalid results");
  }
  const eligible = new Set(transfers.map((transfer) => transfer.guestPath));
  const hits = new Set<string>();
  for (const path of arrayValue(value.cacheHits)) {
    if (typeof path !== "string" || !eligible.has(path) || hits.has(path)) {
      throw new Error("guest input cache probe returned invalid results");
    }
    hits.add(path);
  }
  return hits;
}

async function provisionVisionCoreInput({
  config,
  pass,
  preparation,
}: {
  config: HostConfig;
  pass: number;
  preparation: VisionCorePreparation;
}): Promise<void> {
  const path = join(config.stateRoot, "guest-input.json");
  const guestInput = JSON.parse(await readFile(path, "utf8")) as JsonRecord;
  await writeJson(path, {
    ...guestInput,
    workflowIdentity: {
      ...recordValue(guestInput.workflowIdentity),
      pass,
      visionCore: preparation.guestInput.identity,
    },
    visionCore: preparation.guestInput,
  });
}

export async function stageGuestInputs({
  config,
  contract,
  corePreparation,
  captureResult = capture,
  run = runProcess,
}: {
  config: HostConfig;
  contract: GuestContract;
  corePreparation?: VisionCorePreparation | null;
  captureResult?: typeof capture;
  run?: typeof runProcess;
}): Promise<void> {
  const guest = contract.testbed.guest;
  const remote = `${String(guest.user)}@${String(guest.host)}`;
  const ssh = sshArguments(guest);
  const scp = scpArguments(guest);
  const transfers = uniqueGuestTransfers(corePreparation?.transfers ?? []);
  const transferByteSizes = new Map(
    transfers.map((transfer) => [
      transfer.guestPath,
      guestTransferByteSize(transfer),
    ]),
  );
  const cachedGuestFiles = new Set();
  for (const transfer of transfers) {
    let cacheHit = true;
    for (const probe of guestInputCacheProbes(transfer)) {
      if (
        remotePowerShellCommandLength(probe) > WINDOWS_REMOTE_COMMAND_MAX_CHARS
      ) {
        throw new Error("guest input cache probe exceeds Windows limit");
      }
      const hits = parseGuestInputCacheHits(
        (
          await captureResult(
            "ssh",
            [
              ...ssh,
              remote,
              "powershell.exe",
              "-NoProfile",
              "-EncodedCommand",
              encodedPowerShell(probe),
            ],
            {
              timeoutMs: GUEST_SETUP_TIMEOUT_MS,
              timeoutLabel: "guest input cache probe",
            },
          )
        ).stdout,
        [transfer],
      );
      if (!hits.has(transfer.guestPath)) cacheHit = false;
    }
    if (cacheHit) cachedGuestFiles.add(transfer.guestPath);
  }
  const missingTransfers = transfers.filter(
    (transfer) => !cachedGuestFiles.has(transfer.guestPath),
  );
  const cleanupBlocks: string[] = [
    ...missingTransfers.map((transfer) =>
      [
        `Remove-Item -LiteralPath ${powerShellLiteral(transfer.guestPath)} -Recurse -Force -ErrorAction SilentlyContinue`,
        `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${powerShellLiteral(transfer.guestPath)}) | Out-Null`,
      ].join("\n"),
    ),
    [
      `$guestInput = ${powerShellLiteral(guest.stagingPath)}`,
      "New-Item -ItemType Directory -Force -Path (Split-Path -Parent $guestInput) | Out-Null",
    ].join("\n"),
  ];
  for (const cleanup of boundedPowerShellChunks(cleanupBlocks)) {
    await run(
      "ssh",
      [
        ...ssh,
        remote,
        "powershell.exe",
        "-NoProfile",
        "-EncodedCommand",
        encodedPowerShell(cleanup),
      ],
      {
        timeoutMs: GUEST_SETUP_TIMEOUT_MS,
        timeoutLabel: "guest input staging setup",
      },
    );
  }
  for (const transfer of missingTransfers) {
    const byteSize = transferByteSizes.get(transfer.guestPath) ?? 0;
    const timeoutMs = guestTransferTimeout(byteSize);
    await run(
      "scp",
      [
        ...scp,
        ...(transfer.members ? ["-r"] : []),
        transfer.hostPath,
        `${remote}:${transfer.guestPath}`,
      ],
      {
        timeoutMs,
        timeoutLabel: `guest input staging; bytes=${byteSize}; budgetMs=${timeoutMs}`,
      },
    );
  }
  await run(
    "scp",
    [
      ...scp,
      join(config.stateRoot, "guest-input.json"),
      `${remote}:${String(guest.stagingPath)}`,
    ],
    {
      timeoutMs: GUEST_TRANSFER_TIMEOUT_MS,
      timeoutLabel: "guest input projection staging",
    },
  );
}

export function powerShellFocusArgument(focus: string[]): string {
  if (focus.length === 0) return "";
  const values = focus
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(", ");
  return ` -Focus @(${values})`;
}

export function guestAcceptanceExecuteCommand({
  guestScript,
  mode,
  commit,
  pass,
  focusArgument,
  guestEnvironment = [],
  startupPhase = "single",
}: {
  guestScript: string;
  mode: string;
  commit: string;
  pass: number;
  focusArgument: string;
  guestEnvironment?: Array<{ name: string; value: string }>;
  startupPhase?: GuestStartupPhase;
}): string {
  const environmentPrefix = guestEnvironment
    .map(
      (entry) =>
        `$env:${entry.name} = '${entry.value.replaceAll("'", "''")}'; `,
    )
    .join("");
  return `${environmentPrefix}& '${guestScript.replaceAll("'", "''")}' -Mode '${mode}' -Commit '${commit}' -Pass ${pass}${focusArgument} -StartupPhase '${startupPhase}'`;
}

const GUEST_SCENARIO_ENV_KEYS = [
  "RUN_MANUAL",
  "RUN_DEPARTURE",
  "RUN_DEGRADATION",
] as const;

async function stageAndRunGuest({
  config,
  contract,
  workspace,
  commit,
  mode,
  focus = [],
  pass,
  runRoot,
  visionCoreInputs,
}: {
  config: HostConfig;
  contract: GuestContract;
  workspace: string;
  commit: string;
  mode: string;
  focus?: string[];
  pass: number;
  runRoot: string;
  visionCoreInputs: VisionCorePreparation;
}): Promise<unknown> {
  const guest = contract.testbed.guest;
  const remote = `${String(guest.user)}@${String(guest.host)}`;
  const ssh = sshArguments(guest);
  const scp = scpArguments(guest);
  const processReplayGuestRoot = processReplayGuestDirectory({
    enabled: process.env.VEM_PROCESS_REPLAY === "1",
    mode,
    pass,
  });
  const archive = join(runRoot, `source-pass-${pass}.tar.gz`);
  await runProcess("git", [
    `--git-dir=${config.mirrorPath}`,
    "archive",
    "--format=tar.gz",
    `--output=${archive}`,
    commit,
  ]);
  const remoteArchive = `${config.guestSourcePath}.tar`;
  const createArchiveParent = [
    `$archive = '${remoteArchive.replaceAll("'", "''")}'`,
    "New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archive) | Out-Null",
  ].join("\n");
  await runProcess(
    "ssh",
    [
      ...ssh,
      remote,
      "powershell.exe",
      "-NoProfile",
      "-EncodedCommand",
      encodedPowerShell(createArchiveParent),
    ],
    {
      timeoutMs: GUEST_SETUP_TIMEOUT_MS,
      timeoutLabel: "guest archive parent setup",
    },
  );
  await stageGuestInputs({
    config,
    contract,
    corePreparation: visionCoreInputs,
  });
  await runProcess("scp", [...scp, archive, `${remote}:${remoteArchive}`], {
    timeoutMs: GUEST_TRANSFER_TIMEOUT_MS,
    timeoutLabel: "guest source archive transfer",
  });
  const prepare = [
    `$source = '${config.guestSourcePath.replaceAll("'", "''")}'`,
    `$archive = '${remoteArchive.replaceAll("'", "''")}'`,
    "Remove-Item -LiteralPath $source -Recurse -Force -ErrorAction SilentlyContinue",
    "New-Item -ItemType Directory -Force -Path $source | Out-Null",
    "& tar.exe -xf $archive -C $source",
    "if ($LASTEXITCODE -ne 0) { throw 'source extraction failed' }",
    "Remove-Item -LiteralPath $archive -Force",
    ...(processReplayGuestRoot
      ? [
          `Remove-Item -LiteralPath '${processReplayGuestRoot.replaceAll("'", "''")}' -Recurse -Force -ErrorAction SilentlyContinue`,
        ]
      : []),
  ].join("\n");
  await runProcess(
    "ssh",
    [
      ...ssh,
      remote,
      "powershell.exe",
      "-NoProfile",
      "-EncodedCommand",
      encodedPowerShell(prepare),
    ],
    {
      timeoutMs: GUEST_SETUP_TIMEOUT_MS,
      timeoutLabel: "guest source extraction",
    },
  );
  const ensurePowerShell = `${config.guestSourcePath}\\scripts\\testbed\\ensure-testbed-pwsh.ps1`;
  const preparePowerShell = [
    `$env:GITHUB_PATH = Join-Path $env:TEMP 'vem-testbed-pwsh-path.txt'`,
    `& '${ensurePowerShell.replaceAll("'", "''")}'`,
  ].join("\n");
  await runProcess(
    "ssh",
    [
      ...ssh,
      remote,
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedPowerShell(preparePowerShell),
    ],
    {
      timeoutMs: GUEST_SETUP_TIMEOUT_MS,
      timeoutLabel: "guest PowerShell runtime setup",
    },
  );
  const guestScript = `${config.guestSourcePath}\\scripts\\testbed\\run-local-testbed-guest.ps1`;
  const focusArgument = powerShellFocusArgument(focus);
  const executionBudget = guestAcceptanceExecutionBudget({
    mode,
    focus,
  });
  const guestEnvironment = [
    ...(processReplayGuestRoot
      ? [
          { name: "VEM_PROCESS_REPLAY", value: "1" },
          {
            name: "VEM_PROCESS_REPLAY_DIR",
            value: processReplayGuestRoot,
          },
        ]
      : []),
    ...GUEST_SCENARIO_ENV_KEYS.filter((name) => process.env[name] === "1").map(
      (name) => ({ name, value: "1" }),
    ),
  ];
  const runGuestPhase = async (
    startupPhase: GuestStartupPhase,
  ): Promise<void> => {
    const execute = guestAcceptanceExecuteCommand({
      guestScript,
      mode,
      commit,
      pass,
      focusArgument,
      guestEnvironment,
      startupPhase,
    });
    const invokePowerShell7 = [
      `$pwsh = 'D:\\runtime-cache\\v1\\powershell\\7.4.6\\pwsh.exe'`,
      `& $pwsh -NoProfile -EncodedCommand '${encodedPowerShell(execute)}'`,
      "exit $LASTEXITCODE",
    ].join("\n");
    const phaseBudget =
      startupPhase === "observe_reboot"
        ? {
            timeoutMs: GUEST_STARTUP_OBSERVATION_TIMEOUT_MS,
            timeoutLabel:
              "guest installed-owner reboot observation; no build or business replay",
          }
        : executionBudget;
    try {
      await runProcess(
        "ssh",
        [
          ...ssh,
          remote,
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodedPowerShell(invokePowerShell7),
        ],
        {
          timeoutMs: phaseBudget.timeoutMs,
          timeoutLabel: phaseBudget.timeoutLabel,
        },
      );
    } catch (error) {
      const processError = error as ProcessError;
      if (
        !(
          (processError.command === "ssh" || processError.command === "scp") &&
          (processError.exitCode === 255 || processError.timedOut === true)
        )
      ) {
        processError.businessFailure = true;
      }
      throw processError;
    }
  };
  let guestError: ProcessError | null = null;
  let transportError: ProcessError | null = null;
  try {
    if (mode === "full") {
      await runGuestPhase("prepare_reboot");
      await rebootGuestAfterOwnerInstall({ remote, ssh });
      await runGuestPhase("resume_reboot");
    } else {
      await runGuestPhase("single");
    }
  } catch (error) {
    const processError = error as ProcessError;
    if (processError.businessFailure === true) {
      guestError = processError;
    } else {
      transportError = processError;
    }
  }
  const evidence = join(runRoot, "compact", `pass-${pass}`);
  await mkdir(evidence, { recursive: true });
  const remoteEvidence =
    mode === "clear_cache"
      ? "C:/ProgramData/VEM/testbed/clear-cache-report.json"
      : "C:/ProgramData/VEM/testbed/full-workflow-evidence-bundle";
  await runProcess(
    "scp",
    [...scp, "-r", `${remote}:${remoteEvidence}`, evidence],
    {
      timeoutMs: GUEST_TRANSFER_TIMEOUT_MS,
      timeoutLabel: "guest evidence transfer",
    },
  ).catch(() => undefined);
  if (processReplayGuestRoot) {
    const replayRoot = join(runRoot, "process-replay", `pass-${pass}`);
    await mkdir(replayRoot, { recursive: true });
    try {
      await runProcess(
        "scp",
        [
          ...scp,
          "-r",
          `${remote}:C:/ProgramData/VEM/testbed/process-replay-pass-${pass}`,
          replayRoot,
        ],
        {
          timeoutMs: GUEST_TRANSFER_TIMEOUT_MS,
          timeoutLabel: "guest process replay transfer",
        },
      );
      await synthesizeProcessReplayVideos({ root: replayRoot });
    } catch (error) {
      // 过程视频是供人工核验的支持证据，不得反向改写业务 verdict。
      await writeFile(
        join(replayRoot, "video-synthesis-error.txt"),
        `${(error instanceof Error ? error.message : String(error)).slice(0, 2_048)}\n`,
        "utf8",
      );
    }
  }
  if (transportError) throw transportError;
  if (guestError) {
    const summaryPath = await findFile(evidence, "full-workflow-tracks.json");
    if (summaryPath) {
      try {
        const summary = JSON.parse(
          readFileSync(summaryPath, "utf8"),
        ) as JsonRecord;
        const primary = summarizeGuestBusinessFailures(summary);
        if (primary) {
          guestError.message = `${guestError.message}; ${primary}; evidence=${evidence}`;
        }
      } catch {
        // Evidence parsing must never hide the original guest failure.
      }
    }
    throw guestError;
  }
  const startupObservationOrdinals = additionalStartupRebootObservationOrdinals(
    { mode, focus, pass },
  );
  if (startupObservationOrdinals.length > 0) {
    const observationRoot = join(
      runRoot,
      "compact",
      "startup-reboot-observations",
    );
    await mkdir(observationRoot, { recursive: true });
    const remoteObservationPath =
      "C:/ProgramData/VEM/testbed/startup-reboot-observation.json";
    const observationLoop = await collectStartupRebootObservations({
      ordinals: startupObservationOrdinals,
      observe: async (ordinal) => {
        const reportPath = join(
          observationRoot,
          `startup-reboot-observation-${ordinal}.json`,
        );
        let failedStage = "clear_previous_observation";
        let cycleError: unknown = null;
        try {
          const clearObservation =
            "Remove-Item -LiteralPath 'C:\\ProgramData\\VEM\\testbed\\startup-reboot-observation.json' -Force -ErrorAction SilentlyContinue";
          await runProcess(
            "ssh",
            [
              ...ssh,
              remote,
              "powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              encodedPowerShell(clearObservation),
            ],
            {
              timeoutMs: GUEST_SETUP_TIMEOUT_MS,
              timeoutLabel: `startup reboot observation ${ordinal} cleanup`,
            },
          );
          failedStage = "reboot";
          await rebootGuestAfterOwnerInstall({ remote, ssh });
          failedStage = "post_reboot_owner_observation";
          await runGuestPhase("observe_reboot");
        } catch (error) {
          cycleError = error;
        }
        try {
          await runProcess(
            "scp",
            [...scp, `${remote}:${remoteObservationPath}`, reportPath],
            {
              timeoutMs: GUEST_TRANSFER_TIMEOUT_MS,
              timeoutLabel: `startup reboot observation ${ordinal} evidence transfer`,
            },
          );
        } catch (copyError) {
          const diagnostic = redactSensitiveEvidenceText(
            cycleError instanceof Error
              ? cycleError.message
              : copyError instanceof Error
                ? copyError.message
                : String(cycleError ?? copyError),
          ).slice(0, 1_024);
          await writeJson(reportPath, {
            schemaVersion: "vem-installed-runtime-startup-acceptance/v1",
            ok: false,
            mode: "full",
            commit,
            failedStage,
            reasonCode: "startup_observation_missing",
            diagnostics: [diagnostic || "startup observation was not copied"],
          });
        }
        let report: JsonRecord;
        try {
          report = JSON.parse(await readFile(reportPath, "utf8")) as JsonRecord;
        } catch (error) {
          report = {
            schemaVersion: "vem-installed-runtime-startup-acceptance/v1",
            ok: false,
            mode: "full",
            commit,
            failedStage: "evidence",
            reasonCode: "startup_observation_unreadable",
            diagnostics: [
              redactSensitiveEvidenceText(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 1_024),
            ],
          };
          await writeJson(reportPath, report);
        }
        return {
          ok: cycleError === null && report.ok === true,
          reportPath,
        };
      },
    });
    const passOneStartup = await findFile(
      join(runRoot, "compact", "pass-1"),
      "startup-owner-readiness.json",
    );
    const passTwoStartup = await findFile(
      join(runRoot, "compact", "pass-2"),
      "startup-owner-readiness.json",
    );
    if (!passOneStartup || !passTwoStartup) {
      throw new Error(
        "release full startup observations are missing reconstructed pass reports",
      );
    }
    try {
      await runProcess(
        process.execPath,
        [
          "scripts/testbed/startup-reboot-stability.ts",
          "--commit",
          commit,
          "--reconstructed-pass-one",
          passOneStartup,
          "--reconstructed-pass-two",
          passTwoStartup,
          ...observationLoop.reportPaths.flatMap((reportPath) => [
            "--same-install-repeat",
            reportPath,
          ]),
          "--out",
          join(runRoot, "compact", "startup-reboot-stability.json"),
        ],
        { cwd: workspace },
      );
    } catch (error) {
      const processError = error as ProcessError;
      processError.businessFailure = true;
      throw processError;
    }
  }
  return {};
}

export function summarizeGuestBusinessFailures(
  summary: JsonRecord | null | undefined,
): string | null {
  const failures = arrayValue(recordValue(summary?.businessOutcome).failures);
  if (failures.length === 0) return null;
  const entries = failures
    .filter(
      (entry: unknown) => entry && typeof recordValue(entry).set === "string",
    )
    .map((entry: unknown) => {
      const record = recordValue(entry);
      const reason =
        typeof record.reason === "string" ? record.reason.trim() : "";
      const report =
        typeof record.reportPath === "string" && record.reportPath !== ""
          ? ` (report: ${record.reportPath})`
          : "";
      return `${record.set}: ${reason.slice(0, 400)}${report}`;
    });
  return entries.length > 0 ? entries.join("; ") : null;
}

async function findFile(root: string, name: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested: string | null = await findFile(path, name);
      if (nested) return nested;
    }
  }
  return null;
}

async function executeRun(
  options: OrchestratorOptions,
  config: HostConfig,
): Promise<JsonRecord> {
  const runId = options.runId as string;
  const commit = options.commit as string;
  const mode = options.mode as string;
  const focus = options.focus ?? [];
  const root = runDirectory(config, runId);
  const compact = join(root, "compact");
  let status = (await readJson(statusPath(config, runId))) as JsonRecord;
  const update = async (next: JsonRecord): Promise<void> => {
    const current =
      ((await readJson(statusPath(config, runId), status)) as JsonRecord) ?? {};
    const nextStatus = {
      ...current,
      ...(status ?? {}),
      ...next,
      updatedAt: new Date().toISOString(),
    };
    if (current.status === "superseded") {
      status = current;
      return;
    }
    status = nextStatus;
    if (isTerminalStatus(String(status.status))) {
      await mkdir(compact, { recursive: true });
      await writeJson(join(compact, "status.json"), status);
    }
    await writeJson(statusPath(config, runId), status);
  };
  try {
    await update({ status: "running", phase: "source" });
    await assertMirrorCommit(config, commit);
    const workspace = await materializeWorkspace(config, commit);
    const environment = executionEnvironment(config);
    const lockHash = (
      await capture("git", ["hash-object", "pnpm-lock.yaml"], {
        cwd: workspace,
        env: environment,
      })
    ).stdout.trim();
    const pnpmCacheRoot = join(config.stateRoot, "pnpm", lockHash);
    const pnpmStore = join(pnpmCacheRoot, "store");
    const materializedMarker = join(
      workspace,
      "node_modules",
      ".vem-lock-hash",
    );
    const cachedLockMarker = join(pnpmCacheRoot, ".fetch-complete");
    await mkdir(pnpmCacheRoot, { recursive: true });
    if (!(await readJson(cachedLockMarker, null))) {
      await runProcess(
        "pnpm",
        ["fetch", "--frozen-lockfile", "--store-dir", pnpmStore],
        {
          cwd: workspace,
          env: environment,
        },
      );
      await writeJson(cachedLockMarker, { lockHash });
    }
    const workspaceMarker = (await readJson(
      materializedMarker,
      null,
    )) as JsonRecord | null;
    if (workspaceMarker?.lockHash !== lockHash) {
      await runProcess(
        "pnpm",
        ["install", "--offline", "--frozen-lockfile", "--store-dir", pnpmStore],
        { cwd: workspace, env: environment },
      );
      await writeJson(materializedMarker, { lockHash });
    }
    const contract = JSON.parse(
      readFileSync(config.baselineContract, "utf8"),
    ) as GuestContract;
    const currentFixtureIdentity = fixtureIdentityForWorkspace(workspace);
    const releaseFullAcceptance = mode === "full" && focus.length === 0;
    const passes = reconstructedAcceptancePasses(mode, focus);
    let passOneVisionCoreSnapshot: VisionCorePreparation | null = null;
    let passOneGuestVisionCoreIdentity: string | null = null;
    for (let pass = 1; pass <= passes; pass += 1) {
      if (mode === "full") {
        await update({ phase: `reconstruct-pass-${pass}`, pass });
        const reconstructionOut = join(
          root,
          `reconstruction-pass-${pass}.json`,
        );
        await runProcess(
          process.execPath,
          [
            "scripts/testbed/local-testbed.ts",
            "reconstruct",
            "--mode",
            mode,
            "--run-id",
            `${runId}-PASS-${pass}`,
            "--workspace",
            workspace,
            "--state-root",
            config.stateRoot,
            "--baseline-contract",
            config.baselineContract,
            "--host-private-address",
            config.hostPrivateAddress,
            "--out",
            reconstructionOut,
          ],
          {
            cwd: workspace,
            env: { ...environment, GITHUB_SHA: commit },
          },
        );
      }
      if (mode === "fast") {
        const existingGuestInput = (await readJson(
          join(config.stateRoot, "guest-input.json"),
        )) as JsonRecord | null;
        const reconstructionMarker = (await readJson(
          join(config.stateRoot, "reconstruction.json"),
        )) as JsonRecord | null;
        const fixtureIsCurrent =
          recordValue(existingGuestInput?.fixtureIdentity).sha256 ===
            currentFixtureIdentity.sha256 &&
          recordValue(
            recordValue(reconstructionMarker?.guestInput).fixtureIdentity,
          ).sha256 === currentFixtureIdentity.sha256;
        const preparationOut = fixtureIsCurrent
          ? join(root, `host-runtime-refresh-pass-${pass}.json`)
          : join(root, `reconstruction-pass-${pass}.json`);
        await update({
          phase: fixtureIsCurrent
            ? `refresh-host-runtime-pass-${pass}`
            : `reconstruct-stale-fixture-pass-${pass}`,
          pass,
        });
        await runProcess(
          process.execPath,
          [
            "scripts/testbed/local-testbed.ts",
            fixtureIsCurrent ? "refresh-host-runtime" : "reconstruct",
            "--workspace",
            workspace,
            "--state-root",
            config.stateRoot,
            "--run-id",
            fixtureIsCurrent ? runId : `${runId}-PASS-${pass}`,
            ...(fixtureIsCurrent ? [] : ["--mode", "fast"]),
            "--baseline-contract",
            config.baselineContract,
            "--host-private-address",
            config.hostPrivateAddress,
            "--out",
            preparationOut,
          ],
          {
            cwd: workspace,
            env: { ...environment, GITHUB_SHA: commit },
          },
        );
        const preparation = JSON.parse(
          await readFile(preparationOut, "utf8"),
        ) as JsonRecord;
        const preparationGuestInput = recordValue(preparation.guestInput);
        const preparationRuntimeTestbed = recordValue(
          preparation.runtimeTestbed,
        );
        await update({
          hostRuntimeRefresh: {
            kind: fixtureIsCurrent ? "refresh" : "reconstruct",
            workspace: preparation.workspace,
            guestInput: {
              sha256: preparationGuestInput.sha256,
              machineCode: preparationGuestInput.machineCode,
              hostControlPlane:
                preparationGuestInput.hostControlPlane ??
                preparationRuntimeTestbed.hostControlPlane,
              fixtureIdentity:
                preparationGuestInput.fixtureIdentity ?? currentFixtureIdentity,
            },
            timing: preparation.timing,
          },
        });
      }
      const visionCoreInputs = await materializeVisionCoreArtifactSnapshot(
        config,
        join(root, "vision-core-snapshots", `pass-${pass}`),
        { reuse: true },
      );
      if (
        releaseFullAcceptance &&
        pass === 2 &&
        !identicalVisionCoreArtifactSnapshot(
          passOneVisionCoreSnapshot,
          visionCoreInputs,
        )
      ) {
        throw new Error("full pass 2 Vision core input drifted from pass 1");
      }
      if (releaseFullAcceptance && pass === 1) {
        passOneVisionCoreSnapshot = visionCoreInputs;
        await writeJson(
          join(root, "vision-core-input-pass-1.json"),
          visionCoreInputs.guestInput.identity,
        );
      }
      await provisionVisionCoreInput({
        config,
        pass,
        preparation: visionCoreInputs,
      });
      await update({ phase: `guest-pass-${pass}` });
      await stageAndRunGuest({
        config,
        contract,
        workspace,
        commit,
        mode,
        focus,
        pass,
        runRoot: root,
        visionCoreInputs,
      });
      const coreSummaryPath = await findFile(
        join(compact, `pass-${pass}`),
        "full-workflow-tracks.json",
      );
      if (!coreSummaryPath) {
        throw new Error("guest did not publish validated Vision core identity");
      }
      const guestSummary = JSON.parse(
        await readFile(coreSummaryPath, "utf8"),
      ) as JsonRecord;
      const canonical = (value: unknown): string =>
        JSON.stringify(canonicalIdentity(value));
      const guestCoreIdentity = canonical(
        recordValue(recordValue(guestSummary.identity).visionCore),
      );
      if (
        guestCoreIdentity !== canonical(visionCoreInputs.guestInput.identity)
      ) {
        throw new Error("guest validated Vision core identity is invalid");
      }
      if (releaseFullAcceptance && pass === 1) {
        passOneGuestVisionCoreIdentity = guestCoreIdentity;
      } else if (
        releaseFullAcceptance &&
        guestCoreIdentity !== passOneGuestVisionCoreIdentity
      ) {
        throw new Error(
          "full pass 2 guest Vision core identity drifted from pass 1",
        );
      }
    }
    if (releaseFullAcceptance) {
      await update({ phase: "stability-gate" });
      const passA = await findFile(
        join(compact, "pass-1"),
        "full-workflow-tracks.json",
      );
      const passB = await findFile(
        join(compact, "pass-2"),
        "full-workflow-tracks.json",
      );
      if (!passA || !passB) {
        throw new Error(
          "full acceptance passes did not publish track summaries",
        );
      }
      await runProcess(
        process.execPath,
        [
          "scripts/testbed/full-workflow-stability-gate.ts",
          "--commit",
          commit,
          "--pass-a",
          passA,
          "--pass-b",
          passB,
          "--startup-stability",
          join(compact, "startup-reboot-stability.json"),
          "--out",
          join(compact, "full-workflow-stability-gate.json"),
        ],
        { cwd: workspace, env: environment },
      );
    }
    await update({
      status: "passed",
      phase: "complete",
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const processError = error as ProcessError;
    await update({
      status: processError.businessFailure ? "failed" : "infrastructure_failed",
      phase: status?.phase ?? "unknown",
      error: processError.message,
      finishedAt: new Date().toISOString(),
    });
  }
  return status;
}

async function startRun(
  options: OrchestratorOptions,
  config: HostConfig,
): Promise<JsonRecord> {
  await mkdir(join(config.stateRoot, "runs"), { recursive: true });
  const commit = options.commit as string;
  const mode = options.mode as string;
  const focus = options.focus ?? [];
  await assertMirrorCommit(config, commit);
  const activePath = join(config.stateRoot, "active-run.json");
  const selected = await withRequestLock(config, async () => {
    const active = (await readJson(activePath)) as JsonRecord | null;
    const runId = createRunId(commit, mode);
    if (active && processExists(active.processGroupId)) {
      if (
        active.commit === commit &&
        active.mode === mode &&
        JSON.stringify(active.focus ?? []) === JSON.stringify(focus)
      ) {
        return { existing: true, runId: active.runId };
      }
      if (mode === "clear_cache") {
        throw new Error(
          "clear_cache is accepted only while the testbed is idle",
        );
      }
      const activeRunId = String(active.runId ?? "");
      const previousPath = statusPath(config, activeRunId);
      const previous = (await readJson(previousPath)) as JsonRecord | null;
      if (previous && !TERMINAL.has(String(previous.status))) {
        const superseded = {
          ...previous,
          status: "superseded",
          replacementRunId: runId,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeJson(previousPath, superseded);
        await mkdir(String(previous.compactArtifactPath), {
          recursive: true,
        });
        await writeJson(
          join(String(previous.compactArtifactPath), "status.json"),
          superseded,
        );
      }
      await terminateProcessGroup(active.processGroupId as number);
    }
    const root = runDirectory(config, runId);
    await mkdir(join(root, "compact"), { recursive: true });
    const initial = {
      schemaVersion: STATUS_SCHEMA,
      runId,
      commit,
      mode,
      focus,
      status: "queued",
      phase: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      statusPath: statusPath(config, runId),
      compactArtifactPath: join(root, "compact"),
    };
    await writeJson(statusPath(config, runId), initial);
    const stdout = openSync(join(root, "worker.stdout.log"), "a");
    const stderr = openSync(join(root, "worker.stderr.log"), "a");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(
        process.execPath,
        [
          new URL(import.meta.url).pathname,
          "execute",
          "--mode",
          mode,
          ...focus.flatMap((name) => ["--focus", name]),
          "--commit",
          commit,
          "--run-id",
          runId,
          "--config",
          options.configPath,
        ],
        { detached: true, stdio: ["ignore", stdout, stderr] },
      );
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    await writeJson(activePath, {
      runId,
      commit,
      mode,
      processGroupId: child.pid,
      startedAt: new Date().toISOString(),
    });
    return { existing: false, runId, child };
  });
  const status = await waitForTerminal(config, String(selected.runId));
  await withRequestLock(config, async () => {
    const active = (await readJson(activePath)) as JsonRecord | null;
    if (active?.runId === String(selected.runId)) {
      await rm(activePath, { force: true });
    }
  });
  return status;
}

async function main() {
  const options = parseOrchestratorOptions(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  let status: JsonRecord;
  if (options.command === "status") {
    status = (await readJson(
      statusPath(config, options.runId as string),
    )) as JsonRecord;
    if (!status) throw new Error(`unknown run ${options.runId}`);
  } else if (options.command === "execute") {
    status = await executeRun(options, config);
  } else {
    status = await startRun(options, config);
  }
  process.stdout.write(`${JSON.stringify(callerResult(status))}\n`);
  process.exitCode = exitCodeFor(status);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exitCode = 2;
  });
}
