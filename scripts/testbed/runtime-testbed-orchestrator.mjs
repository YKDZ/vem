#!/usr/bin/env node

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

import {
  buildFunctionalAiAcceptanceGuestInput,
  identicalAiAcceptanceInputSnapshot,
} from "./ai-acceptance-input-provisioning.mjs";
import { selectBusinessChecks } from "./business-check-registry.mjs";

const MODES = new Set(["fast", "full", "clear_cache"]);
const TERMINAL = new Set([
  "passed",
  "failed",
  "infrastructure_failed",
  "superseded",
]);
const isTerminalStatus = (status) => TERMINAL.has(status);
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
const WINDOWS_REMOTE_COMMAND_MAX_CHARS = 8_000;
const GUEST_ACCEPTANCE_INPUT_CACHE = "D:\\runtime-cache\\v1\\acceptance-inputs";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function guestAcceptanceExecutionBudget({ mode, focus = [], registry }) {
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

function artifactFile(value, label, sourceCommit = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const expectedKeys = sourceCommit
    ? ["hostPath", "sha256", "byteSize", "sourceCommit"]
    : ["hostPath", "sha256", "byteSize"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")) {
    throw new Error(`${label} fields are invalid`);
  }
  const path = absolute(value.hostPath, `${label} hostPath`);
  if (!/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize <= 0) {
    throw new Error(`${label} byte size is invalid`);
  }
  if (sourceCommit && !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? "")) {
    throw new Error(`${label} source commit is invalid`);
  }
  return {
    hostPath: path,
    sha256: value.sha256,
    byteSize: value.byteSize,
    ...(sourceCommit ? { sourceCommit: value.sourceCommit } : {}),
  };
}

function absolute(value, label) {
  const path = required(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function option(args, name, optional = false) {
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

function repeatableOption(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    values.push(required(args[index + 1], `--${name}`));
    index += 1;
  }
  return values;
}

export function parseOrchestratorOptions(args) {
  const command = args[0];
  if (!new Set(["run", "status", "execute"]).has(command)) {
    throw new Error(
      "usage: runtime-testbed-orchestrator.mjs run|status --config <path> ...",
    );
  }
  const common = {
    command,
    configPath: absolute(option(args, "config"), "--config"),
  };
  if (command === "status") {
    return { ...common, runId: required(option(args, "run-id"), "--run-id") };
  }
  const mode = option(args, "mode");
  if (!MODES.has(mode))
    throw new Error("--mode must be fast, full, or clear_cache");
  const commit = option(args, "commit").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("--commit must be a full 40-character Git SHA");
  }
  const focus = repeatableOption(args, "focus");
  if (mode !== "fast" && focus.length > 0) {
    throw new Error("--focus is only valid with --mode fast");
  }
  return {
    ...common,
    mode,
    commit,
    focus,
    runId: option(args, "run-id", command === "run"),
  };
}

export function validateHostConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host config must be an object");
  }
  if (value.schemaVersion !== CONFIG_SCHEMA) {
    throw new Error(`host config schemaVersion must be ${CONFIG_SCHEMA}`);
  }
  const hostPrivateAddress = required(
    value.hostPrivateAddress,
    "host config hostPrivateAddress",
  );
  if (isIP(hostPrivateAddress) !== 4 || hostPrivateAddress.startsWith("127.")) {
    throw new Error(
      "host config hostPrivateAddress must be a non-loopback IPv4 address",
    );
  }
  const guestSourcePath = required(
    value.guestSourcePath,
    "host config guestSourcePath",
  );
  if (!/^[A-Za-z]:\\/.test(guestSourcePath)) {
    throw new Error(
      "host config guestSourcePath must be an absolute Windows path",
    );
  }
  const environment = value.environment ?? {};
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
  const pathPrepend = value.pathPrepend ?? [];
  if (!Array.isArray(pathPrepend)) {
    throw new Error("host config pathPrepend must be an array");
  }
  if (
    !value.visionCoreArtifacts ||
    typeof value.visionCoreArtifacts !== "object" ||
    Array.isArray(value.visionCoreArtifacts) ||
    Object.keys(value.visionCoreArtifacts).sort().join("\0") !==
      ["runtimeArchive", "recordedFixtureArchive"].sort().join("\0")
  ) {
    throw new Error(
      "host config visionCoreArtifacts must contain exact-two artifacts",
    );
  }
  return {
    schemaVersion: CONFIG_SCHEMA,
    mirrorPath: absolute(value.mirrorPath, "host config mirrorPath"),
    workspaceRoot: absolute(value.workspaceRoot, "host config workspaceRoot"),
    stateRoot: absolute(value.stateRoot, "host config stateRoot"),
    baselineContract: absolute(
      value.baselineContract,
      "host config baselineContract",
    ),
    hostPrivateAddress,
    guestSourcePath,
    environment: { ...environment },
    pathPrepend: pathPrepend.map((path) =>
      absolute(path, "host config pathPrepend entry"),
    ),
    ...(value.aiVirtualTryOnFunctional === undefined
      ? {}
      : (() => {
          const functional = value.aiVirtualTryOnFunctional;
          if (
            !functional ||
            typeof functional !== "object" ||
            Array.isArray(functional)
          ) {
            throw new Error(
              "host config aiVirtualTryOnFunctional must be an object",
            );
          }
          if (
            Object.keys(functional).sort().join("\0") !==
            [
              "materializedModelPackRoot",
              "modelPackArchive",
              "modelPackByteSize",
              "modelPackSha256",
            ]
              .sort()
              .join("\0")
          ) {
            throw new Error(
              "host config aiVirtualTryOnFunctional fields are invalid",
            );
          }
          if (
            !/^[a-f0-9]{64}$/.test(functional.modelPackSha256) ||
            !Number.isSafeInteger(functional.modelPackByteSize) ||
            functional.modelPackByteSize <= 0
          ) {
            throw new Error(
              "host config aiVirtualTryOnFunctional model pack identity is invalid",
            );
          }
          return {
            aiVirtualTryOnFunctional: {
              materializedModelPackRoot: absolute(
                functional.materializedModelPackRoot,
                "host config aiVirtualTryOnFunctional materializedModelPackRoot",
              ),
              modelPackArchive: absolute(
                functional.modelPackArchive,
                "host config aiVirtualTryOnFunctional modelPackArchive",
              ),
              modelPackByteSize: functional.modelPackByteSize,
              modelPackSha256: functional.modelPackSha256,
            },
          };
        })()),
    visionCoreArtifacts: {
      runtimeArchive: artifactFile(
        value.visionCoreArtifacts?.runtimeArchive,
        "host config visionCoreArtifacts.runtimeArchive",
        true,
      ),
      recordedFixtureArchive: artifactFile(
        value.visionCoreArtifacts?.recordedFixtureArchive,
        "host config visionCoreArtifacts.recordedFixtureArchive",
        true,
      ),
    },
  };
}

function executionEnvironment(config) {
  return {
    ...process.env,
    ...config.environment,
    PATH: [...config.pathPrepend, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(":"),
  };
}

async function loadConfig(path) {
  return validateHostConfig(JSON.parse(await readFile(path, "utf8")));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timeout = null;
    let killTimeout = null;
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
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    if (Number.isInteger(options.timeoutMs) && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        const error = new Error(
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
        const error = new Error(
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

async function capture(command, args, options = {}) {
  let stdout = "";
  let stderr = "";
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timeout =
      Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
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
    child.once("error", (error) => {
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

function runDirectory(config, runId) {
  return join(config.stateRoot, "runs", runId);
}

function fixtureIdentityForWorkspace(workspace) {
  const raw = readFileSync(
    join(workspace, "scripts/testbed/fixtures/local-testbed-catalog.json"),
    "utf8",
  );
  const seedSource = readFileSync(
    join(workspace, "scripts/testbed/local-testbed.mjs"),
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

export function createRunId(commit, mode, now = Date.now()) {
  return `RUN-${now}-${commit.slice(0, 12).toUpperCase()}-${mode.toUpperCase()}`;
}

function statusPath(config, runId) {
  return join(runDirectory(config, runId), "status.json");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.tmp`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(pending, path);
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function withRequestLock(config, action) {
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
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error("timed out acquiring testbed scheduler lock");
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId < 2) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessGroup(processGroupId) {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processGroupExists(processGroupId)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (processGroupExists(processGroupId)) {
    throw new Error(`failed to terminate process group ${processGroupId}`);
  }
}

async function waitForTerminal(config, runId) {
  while (true) {
    const status = await readJson(statusPath(config, runId));
    if (!status) throw new Error(`run ${runId} has no canonical status`);
    if (TERMINAL.has(status.status)) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

function exitCodeFor(status) {
  if (status.status === "passed") return 0;
  if (status.status === "superseded") return 75;
  if (status.status === "failed") return 1;
  return 2;
}

function callerResult(status) {
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

async function assertMirrorCommit(config, commit) {
  await capture("git", [
    `--git-dir=${config.mirrorPath}`,
    "cat-file",
    "-e",
    `${commit}^{commit}`,
  ]);
}

async function materializeWorkspace(config, commit) {
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

function sshArguments(guest) {
  return [
    "-i",
    guest.identityFile,
    "-o",
    `UserKnownHostsFile=${guest.knownHostsFile}`,
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

function scpArguments(guest) {
  return ["-O", ...sshArguments(guest)];
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function remotePowerShellCommandLength(script) {
  return [
    "powershell.exe",
    "-NoProfile",
    "-EncodedCommand",
    encodedPowerShell(script),
  ].join(" ").length;
}

function boundedPowerShellChunks(blocks) {
  const chunks = [];
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

function requiresAiAcceptanceInputs(options) {
  return (
    options.mode === "full" ||
    (options.mode === "fast" && options.focus.includes("aiVirtualTryOn"))
  );
}

function canonicalIdentity(value) {
  if (Array.isArray(value)) return value.map(canonicalIdentity);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalIdentity(value[key])]),
    );
  }
  return value;
}

export async function admitFunctionalAiAcceptanceInputs(config) {
  if (!config.aiVirtualTryOnFunctional) {
    throw new Error(
      "AI virtual try-on functional acceptance requires host config aiVirtualTryOnFunctional",
    );
  }
  return await buildFunctionalAiAcceptanceGuestInput(config);
}

function visionCoreIdentity(runtime, fixture) {
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

async function assertVisionCoreArtifact(artifact, label) {
  let entry;
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

export async function loadVisionCoreArtifacts(config) {
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
  const guestFile = (artifact, name) =>
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
      { ...runtime, guestPath: guestFile(runtime, "vision-runtime.zip") },
      { ...fixture, guestPath: guestFile(fixture, "recorded-fixtures.zip") },
    ],
  };
}

export async function materializeVisionCoreArtifactSnapshot(
  config,
  root,
  { reuse = false } = {},
) {
  const preparation = await loadVisionCoreArtifacts(config);
  if (reuse) {
    await Promise.all(
      preparation.transfers.map((transfer) =>
        assertVisionCoreArtifact(transfer, "Vision core artifact"),
      ),
    );
    return preparation;
  }
  const snapshotRoot = resolve(root, preparation.guestInput.identity.sha256);
  await mkdir(snapshotRoot, { recursive: true });
  const names = ["vision-runtime.zip", "recorded-fixtures.zip"];
  const transfers = preparation.transfers.map((transfer, index) => ({
    ...transfer,
    hostPath: join(snapshotRoot, names[index]),
  }));
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

export function identicalVisionCoreArtifactSnapshot(left, right) {
  return (
    Boolean(left && right) &&
    JSON.stringify(left.guestInput.identity) ===
      JSON.stringify(right.guestInput.identity)
  );
}

export async function provisionAiAcceptanceGuestInput({
  config,
  preparation,
  pass,
}) {
  const path = join(config.stateRoot, "guest-input.json");
  const guestInput = JSON.parse(await readFile(path, "utf8"));
  if (guestInput?.schemaVersion !== "vem-local-testbed-guest-input/v1") {
    throw new Error(
      "AI guest input provision requires canonical local testbed guest input",
    );
  }
  const acceptanceBlocks = { ...(guestInput.acceptanceBlocks ?? {}) };
  delete acceptanceBlocks.aiVirtualTryOn;
  const {
    acceptanceBlocks: _previousAcceptanceBlocks,
    ...guestInputWithoutBlocks
  } = guestInput;
  await writeJson(path, {
    ...guestInputWithoutBlocks,
    workflowIdentity: {
      ...guestInput.workflowIdentity,
      aiVirtualTryOn: {
        input: preparation.guestInput.identities,
      },
      pass,
    },
    aiVirtualTryOn: preparation.guestInput,
    ...(Object.keys(acceptanceBlocks).length > 0 ? { acceptanceBlocks } : {}),
  });
}

export async function provisionAiAcceptanceBlock({ config, pass, reason }) {
  const path = join(config.stateRoot, "guest-input.json");
  const guestInput = JSON.parse(await readFile(path, "utf8"));
  await writeJson(path, {
    ...guestInput,
    workflowIdentity: { ...guestInput.workflowIdentity, pass },
    acceptanceBlocks: {
      ...guestInput.acceptanceBlocks,
      aiVirtualTryOn: reason,
    },
  });
}

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function uniqueGuestTransfers(transfers) {
  const unique = new Map();
  for (const transfer of transfers) {
    const previous = unique.get(transfer.guestPath);
    if (!previous) {
      unique.set(transfer.guestPath, transfer);
      continue;
    }
    const identity = ({ byteSize, members, sha256, sourceCommit }) =>
      JSON.stringify({
        byteSize,
        members: members ?? null,
        sha256,
        sourceCommit: sourceCommit ?? null,
      });
    if (identity(previous) !== identity(transfer)) {
      throw new Error("guest input cache destination identity conflicts");
    }
  }
  return [...unique.values()];
}

function guestTransferByteSize(transfer) {
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

function guestTransferTimeout(byteSize) {
  return Math.min(
    GUEST_TRANSFER_MAX_TIMEOUT_MS,
    Math.max(
      GUEST_TRANSFER_TIMEOUT_MS,
      GUEST_TRANSFER_STARTUP_ALLOWANCE_MS +
        Math.ceil((byteSize / GUEST_TRANSFER_MIN_BYTES_PER_SECOND) * 1_000),
    ),
  );
}

function guestInputCacheProbes(transfer) {
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

function parseGuestInputCacheHits(output, transfers) {
  let value;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error("AI guest input cache probe returned invalid JSON");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "cacheHits" ||
    !Array.isArray(value.cacheHits)
  ) {
    throw new Error("AI guest input cache probe returned invalid results");
  }
  const eligible = new Set(transfers.map((transfer) => transfer.guestPath));
  const hits = new Set();
  for (const path of value.cacheHits) {
    if (typeof path !== "string" || !eligible.has(path) || hits.has(path)) {
      throw new Error("AI guest input cache probe returned invalid results");
    }
    hits.add(path);
  }
  return hits;
}

async function provisionVisionCoreInput({ config, pass, preparation }) {
  const path = join(config.stateRoot, "guest-input.json");
  const guestInput = JSON.parse(await readFile(path, "utf8"));
  await writeJson(path, {
    ...guestInput,
    workflowIdentity: {
      ...guestInput.workflowIdentity,
      pass,
      visionCore: preparation.guestInput.identity,
    },
    visionCore: preparation.guestInput,
  });
}

export async function stageAiAcceptanceInputs({
  config,
  contract,
  preparation,
  corePreparation,
  captureResult = capture,
  run = runProcess,
}) {
  const guest = contract.testbed.guest;
  const remote = `${guest.user}@${guest.host}`;
  const ssh = sshArguments(guest);
  const scp = scpArguments(guest);
  const transfers = uniqueGuestTransfers([
    ...(corePreparation?.transfers ?? []),
    ...(preparation?.transfers ?? []),
  ]);
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
              timeoutLabel: "AI guest input cache probe",
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
  const cleanupBlocks = [
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
        timeoutLabel: "AI guest input staging setup",
      },
    );
  }
  for (const transfer of missingTransfers) {
    const byteSize = transferByteSizes.get(transfer.guestPath);
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
        timeoutLabel: `AI guest input staging; bytes=${byteSize}; budgetMs=${timeoutMs}`,
      },
    );
  }
  await run(
    "scp",
    [
      ...scp,
      join(config.stateRoot, "guest-input.json"),
      `${remote}:${guest.stagingPath}`,
    ],
    {
      timeoutMs: GUEST_TRANSFER_TIMEOUT_MS,
      timeoutLabel: "AI guest input projection staging",
    },
  );
}

export function powerShellFocusArgument(focus) {
  if (focus.length === 0) return "";
  const values = focus
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(", ");
  return ` -Focus @(${values})`;
}

async function stageAndRunGuest({
  config,
  contract,
  workspace,
  commit,
  mode,
  focus = [],
  pass,
  runRoot,
  aiAcceptanceInputs,
  visionCoreInputs,
}) {
  const guest = contract.testbed.guest;
  const remote = `${guest.user}@${guest.host}`;
  const ssh = sshArguments(guest);
  const scp = scpArguments(guest);
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
  await stageAiAcceptanceInputs({
    config,
    contract,
    preparation: aiAcceptanceInputs,
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
  const execute = `& '${guestScript.replaceAll("'", "''")}' -Mode '${mode}' -Commit '${commit}' -Pass ${pass}${focusArgument}`;
  const invokePowerShell7 = [
    `$pwsh = 'D:\\runtime-cache\\v1\\powershell\\7.4.6\\pwsh.exe'`,
    `& $pwsh -NoProfile -EncodedCommand '${encodedPowerShell(execute)}'`,
    "exit $LASTEXITCODE",
  ].join("\n");
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
        timeoutMs: executionBudget.timeoutMs,
        timeoutLabel: executionBudget.timeoutLabel,
      },
    );
  } catch (error) {
    if (
      (error.command === "ssh" || error.command === "scp") &&
      (error.exitCode === 255 || error.timedOut === true)
    ) {
      error.businessFailure = false;
    } else {
      error.businessFailure = true;
    }
    throw error;
  } finally {
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
  }
  return {};
}

async function findFile(root, name) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = await findFile(path, name);
      if (nested) return nested;
    }
  }
  return null;
}

async function executeRun(options, config) {
  const root = runDirectory(config, options.runId);
  const compact = join(root, "compact");
  let status = await readJson(statusPath(config, options.runId));
  const update = async (next) => {
    const current =
      (await readJson(statusPath(config, options.runId), status)) ?? {};
    const nextStatus = {
      ...current,
      ...status,
      ...next,
      updatedAt: new Date().toISOString(),
    };
    if (current.status === "superseded") {
      status = current;
      return;
    }
    status = nextStatus;
    if (isTerminalStatus(status.status)) {
      await mkdir(compact, { recursive: true });
      await writeJson(join(compact, "status.json"), status);
    }
    await writeJson(statusPath(config, options.runId), status);
  };
  try {
    await update({ status: "running", phase: "source" });
    await assertMirrorCommit(config, options.commit);
    const workspace = await materializeWorkspace(config, options.commit);
    const environment = executionEnvironment(config);
    const aiInputRequired = requiresAiAcceptanceInputs(options);
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
    const workspaceMarker = await readJson(materializedMarker, null);
    if (workspaceMarker?.lockHash !== lockHash) {
      await runProcess(
        "pnpm",
        ["install", "--offline", "--frozen-lockfile", "--store-dir", pnpmStore],
        { cwd: workspace, env: environment },
      );
      await writeJson(materializedMarker, { lockHash });
    }
    const contract = JSON.parse(readFileSync(config.baselineContract, "utf8"));
    const currentFixtureIdentity = fixtureIdentityForWorkspace(workspace);
    const passes = options.mode === "full" ? 2 : 1;
    let passOneAiInputSnapshot = null;
    let passOneGuestAiIdentity = null;
    let passOneVisionCoreSnapshot = null;
    let passOneGuestVisionCoreIdentity = null;
    for (let pass = 1; pass <= passes; pass += 1) {
      let aiAcceptanceInputs = null;
      let aiInputFailure = null;
      if (aiInputRequired) {
        try {
          aiAcceptanceInputs = await admitFunctionalAiAcceptanceInputs(config);
        } catch (error) {
          aiInputFailure =
            error instanceof Error ? error.message : String(error);
        }
      }
      const snapshot = aiAcceptanceInputs && {
        manifestSha256: aiAcceptanceInputs.manifestSha256,
        artifactDigests: aiAcceptanceInputs.artifactDigests,
      };
      if (
        options.mode === "full" &&
        pass === 2 &&
        !identicalAiAcceptanceInputSnapshot(passOneAiInputSnapshot, snapshot)
      ) {
        aiAcceptanceInputs = null;
        aiInputFailure = "full pass 2 AI acceptance input drifted from pass 1";
      }
      if (options.mode === "full" && pass === 1 && snapshot) {
        passOneAiInputSnapshot = snapshot;
        await writeJson(
          join(root, "ai-acceptance-input-pass-1.json"),
          snapshot,
        );
      }
      if (options.mode === "full") {
        await update({ phase: `reconstruct-pass-${pass}`, pass });
        const reconstructionOut = join(
          root,
          `reconstruction-pass-${pass}.json`,
        );
        await runProcess(
          process.execPath,
          [
            "scripts/testbed/local-testbed.mjs",
            "reconstruct",
            "--mode",
            options.mode,
            "--run-id",
            `${options.runId}-PASS-${pass}`,
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
            env: { ...environment, GITHUB_SHA: options.commit },
          },
        );
      }
      if (options.mode === "fast") {
        const existingGuestInput = await readJson(
          join(config.stateRoot, "guest-input.json"),
        );
        const reconstructionMarker = await readJson(
          join(config.stateRoot, "reconstruction.json"),
        );
        const fixtureIsCurrent =
          existingGuestInput?.fixtureIdentity?.sha256 ===
            currentFixtureIdentity.sha256 &&
          reconstructionMarker?.guestInput?.fixtureIdentity?.sha256 ===
            currentFixtureIdentity.sha256;
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
            "scripts/testbed/local-testbed.mjs",
            fixtureIsCurrent ? "refresh-host-runtime" : "reconstruct",
            "--workspace",
            workspace,
            "--state-root",
            config.stateRoot,
            "--run-id",
            fixtureIsCurrent ? options.runId : `${options.runId}-PASS-${pass}`,
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
            env: { ...environment, GITHUB_SHA: options.commit },
          },
        );
        const preparation = JSON.parse(await readFile(preparationOut, "utf8"));
        await update({
          hostRuntimeRefresh: {
            kind: fixtureIsCurrent ? "refresh" : "reconstruct",
            workspace: preparation.workspace,
            guestInput: {
              sha256: preparation.guestInput.sha256,
              machineCode: preparation.guestInput.machineCode,
              hostControlPlane:
                preparation.guestInput.hostControlPlane ??
                preparation.runtimeTestbed?.hostControlPlane,
              fixtureIdentity:
                preparation.guestInput.fixtureIdentity ??
                currentFixtureIdentity,
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
        options.mode === "full" &&
        pass === 2 &&
        !identicalVisionCoreArtifactSnapshot(
          passOneVisionCoreSnapshot,
          visionCoreInputs,
        )
      ) {
        throw new Error("full pass 2 Vision core input drifted from pass 1");
      }
      if (options.mode === "full" && pass === 1) {
        passOneVisionCoreSnapshot = visionCoreInputs;
        await writeJson(
          join(root, "vision-core-input-pass-1.json"),
          visionCoreInputs.guestInput.identity,
        );
      }
      if (aiAcceptanceInputs) {
        const currentAiAcceptanceInputs =
          await admitFunctionalAiAcceptanceInputs(config);
        const currentSnapshot = {
          manifestSha256: currentAiAcceptanceInputs.manifestSha256,
          artifactDigests: currentAiAcceptanceInputs.artifactDigests,
        };
        if (!identicalAiAcceptanceInputSnapshot(snapshot, currentSnapshot)) {
          throw new Error(
            "AI acceptance inputs changed during host preparation",
          );
        }
        await provisionAiAcceptanceGuestInput({
          config,
          preparation: currentAiAcceptanceInputs,
          pass,
        });
      } else if (aiInputFailure) {
        await provisionAiAcceptanceBlock({
          config,
          pass,
          reason: `AI acceptance input blocked: ${aiInputFailure}`,
        });
      }
      await provisionVisionCoreInput({
        config,
        pass,
        preparation: visionCoreInputs,
      });
      await update({ phase: `guest-pass-${pass}` });
      const guestExecution = await stageAndRunGuest({
        config,
        contract,
        workspace,
        commit: options.commit,
        mode: options.mode,
        focus: options.focus,
        pass,
        runRoot: root,
        aiAcceptanceInputs,
        visionCoreInputs,
      });
      const coreSummaryPath = await findFile(
        join(compact, `pass-${pass}`),
        "full-workflow-tracks.json",
      );
      if (!coreSummaryPath) {
        throw new Error("guest did not publish validated Vision core identity");
      }
      const guestSummary = JSON.parse(await readFile(coreSummaryPath, "utf8"));
      const guestAiInputIdentity = guestSummary?.identity?.aiVirtualTryOn?.input;
      const canonical = (value) => JSON.stringify(canonicalIdentity(value));
      if (aiAcceptanceInputs) {
        if (!guestAiInputIdentity) {
          throw new Error("guest did not publish validated AI input identity");
        }
        const guestIdentity = canonical(guestAiInputIdentity);
        if (options.mode === "full" && pass === 1) {
          passOneGuestAiIdentity = guestIdentity;
        } else if (
          options.mode === "full" &&
          guestIdentity !== passOneGuestAiIdentity
        ) {
          throw new Error(
            "full pass 2 guest validated AI input drifted from pass 1",
          );
        }
      }
      const guestCoreIdentity = canonical(guestSummary?.identity?.visionCore);
      if (
        guestCoreIdentity !==
        canonical(visionCoreInputs.guestInput.identity)
      ) {
        throw new Error("guest validated Vision core identity is invalid");
      }
      if (options.mode === "full" && pass === 1) {
        passOneGuestVisionCoreIdentity = guestCoreIdentity;
      } else if (
        options.mode === "full" &&
        guestCoreIdentity !== passOneGuestVisionCoreIdentity
      ) {
        throw new Error(
          "full pass 2 guest Vision core identity drifted from pass 1",
        );
      }
    }
    if (options.mode === "full") {
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
          "scripts/testbed/full-workflow-stability-gate.mjs",
          "--commit",
          options.commit,
          "--pass-a",
          passA,
          "--pass-b",
          passB,
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
    await update({
      status: error.businessFailure ? "failed" : "infrastructure_failed",
      phase: status?.phase ?? "unknown",
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
  }
  return status;
}

async function startRun(options, config) {
  await mkdir(join(config.stateRoot, "runs"), { recursive: true });
  await assertMirrorCommit(config, options.commit);
  const activePath = join(config.stateRoot, "active-run.json");
  const selected = await withRequestLock(config, async () => {
    const active = await readJson(activePath);
    const runId = createRunId(options.commit, options.mode);
    if (active && processExists(active.processGroupId)) {
      if (
        active.commit === options.commit &&
        active.mode === options.mode &&
        JSON.stringify(active.focus ?? []) ===
          JSON.stringify(options.focus ?? [])
      ) {
        return { existing: true, runId: active.runId };
      }
      if (options.mode === "clear_cache") {
        throw new Error(
          "clear_cache is accepted only while the testbed is idle",
        );
      }
      const previousPath = statusPath(config, active.runId);
      const previous = await readJson(previousPath);
      if (previous && !TERMINAL.has(previous.status)) {
        const superseded = {
          ...previous,
          status: "superseded",
          replacementRunId: runId,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeJson(previousPath, superseded);
        await mkdir(previous.compactArtifactPath, { recursive: true });
        await writeJson(
          join(previous.compactArtifactPath, "status.json"),
          superseded,
        );
      }
      await terminateProcessGroup(active.processGroupId);
    }
    const root = runDirectory(config, runId);
    await mkdir(join(root, "compact"), { recursive: true });
    const initial = {
      schemaVersion: STATUS_SCHEMA,
      runId,
      commit: options.commit,
      mode: options.mode,
      focus: options.focus,
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
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          new URL(import.meta.url).pathname,
          "execute",
          "--mode",
          options.mode,
          ...options.focus.flatMap((name) => ["--focus", name]),
          "--commit",
          options.commit,
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
      commit: options.commit,
      mode: options.mode,
      processGroupId: child.pid,
      startedAt: new Date().toISOString(),
    });
    return { existing: false, runId, child };
  });
  const status = await waitForTerminal(config, selected.runId);
  await withRequestLock(config, async () => {
    const active = await readJson(activePath);
    if (active?.runId === selected.runId) await rm(activePath, { force: true });
  });
  return status;
}

async function main() {
  const options = parseOrchestratorOptions(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  let status;
  if (options.command === "status") {
    status = await readJson(statusPath(config, options.runId));
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
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  });
}
