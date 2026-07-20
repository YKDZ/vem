#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  cp,
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

const MODES = new Set(["fast", "full", "clear_cache"]);
const TERMINAL = new Set([
  "passed",
  "failed",
  "infrastructure_failed",
  "superseded",
]);
const STATUS_SCHEMA = "vem-runtime-testbed-run/v1";
const CONFIG_SCHEMA = "vem-runtime-testbed-host/v1";

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
  return {
    ...common,
    mode,
    commit,
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
      detached: options.detached ?? false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise({ code, signal, pid: child.pid });
      else {
        const error = new Error(
          `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
        );
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
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
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
  ];
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function stageAndRunGuest({
  config,
  contract,
  workspace,
  commit,
  mode,
  pass,
  runRoot,
}) {
  const guest = contract.testbed.guest;
  const archive = join(runRoot, `source-pass-${pass}.tar`);
  await runProcess("git", [
    `--git-dir=${config.mirrorPath}`,
    "archive",
    "--format=tar",
    `--output=${archive}`,
    commit,
  ]);
  const remote = `${guest.user}@${guest.host}`;
  const ssh = sshArguments(guest);
  const remoteArchive = `${config.guestSourcePath}.tar`;
  await runProcess("scp", [...ssh, archive, `${remote}:${remoteArchive}`]);
  const prepare = [
    `$source = '${config.guestSourcePath.replaceAll("'", "''")}'`,
    `$archive = '${remoteArchive.replaceAll("'", "''")}'`,
    "Remove-Item -LiteralPath $source -Recurse -Force -ErrorAction SilentlyContinue",
    "New-Item -ItemType Directory -Force -Path $source | Out-Null",
    "& tar.exe -xf $archive -C $source",
    "if ($LASTEXITCODE -ne 0) { throw 'source extraction failed' }",
    "Remove-Item -LiteralPath $archive -Force",
  ].join("\n");
  await runProcess("ssh", [
    ...ssh,
    remote,
    "powershell.exe",
    "-NoProfile",
    "-EncodedCommand",
    encodedPowerShell(prepare),
  ]);
  const guestScript = `${config.guestSourcePath}\\scripts\\testbed\\run-local-testbed-guest.ps1`;
  const execute = `& '${guestScript.replaceAll("'", "''")}' -Mode '${mode}'`;
  try {
    await runProcess("ssh", [
      ...ssh,
      remote,
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedPowerShell(execute),
    ]);
  } catch (error) {
    error.businessFailure = true;
    throw error;
  } finally {
    const evidence = join(runRoot, "compact", `pass-${pass}`);
    await mkdir(evidence, { recursive: true });
    const remoteEvidence =
      mode === "clear_cache"
        ? "C:/ProgramData/VEM/runtime/testbed/clear-cache-report.json"
        : "C:/ProgramData/VEM/runtime/testbed/full-workflow-evidence-bundle";
    await runProcess("scp", [
      ...ssh,
      "-r",
      `${remote}:${remoteEvidence}`,
      evidence,
    ]).catch(() => undefined);
  }
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
    status = { ...status, ...next, updatedAt: new Date().toISOString() };
    await writeJson(statusPath(config, options.runId), status);
  };
  try {
    await update({ status: "running", phase: "source" });
    await assertMirrorCommit(config, options.commit);
    const workspace = await materializeWorkspace(config, options.commit);
    const environment = executionEnvironment(config);
    await runProcess("pnpm", ["install", "--frozen-lockfile"], {
      cwd: workspace,
      env: environment,
    });
    const contract = JSON.parse(readFileSync(config.baselineContract, "utf8"));
    const passes = options.mode === "full" ? 2 : 1;
    for (let pass = 1; pass <= passes; pass += 1) {
      await update({ phase: `reconstruct-pass-${pass}`, pass });
      const reconstructionOut = join(root, `reconstruction-pass-${pass}.json`);
      await runProcess(
        process.execPath,
        [
          "scripts/testbed/local-testbed.mjs",
          "reconstruct",
          "--mode",
          options.mode,
          "--run-id",
          `${options.runId}-pass-${pass}`,
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
        { cwd: workspace, env: { ...environment, GITHUB_SHA: options.commit } },
      );
      await update({ phase: `guest-pass-${pass}` });
      await stageAndRunGuest({
        config,
        contract,
        workspace,
        commit: options.commit,
        mode: options.mode,
        pass,
        runRoot: root,
      });
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
    const current = await readJson(statusPath(config, options.runId), status);
    if (current?.status === "superseded") {
      status = current;
    } else {
      await update({
        status: error.businessFailure ? "failed" : "infrastructure_failed",
        phase: status?.phase ?? "unknown",
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
    }
  }
  await mkdir(compact, { recursive: true });
  await cp(statusPath(config, options.runId), join(compact, "status.json"));
  return status;
}

async function startRun(options, config) {
  await mkdir(join(config.stateRoot, "runs"), { recursive: true });
  await assertMirrorCommit(config, options.commit);
  const activePath = join(config.stateRoot, "active-run.json");
  const selected = await withRequestLock(config, async () => {
    const active = await readJson(activePath);
    const runId = `${Date.now()}-${options.commit.slice(0, 12)}-${options.mode}`;
    if (active && processExists(active.processGroupId)) {
      if (active.commit === options.commit && active.mode === options.mode) {
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
      status: "queued",
      phase: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      statusPath: statusPath(config, runId),
      compactArtifactPath: join(root, "compact"),
    };
    await writeJson(statusPath(config, runId), initial);
    const child = spawn(
      process.execPath,
      [
        new URL(import.meta.url).pathname,
        "execute",
        "--mode",
        options.mode,
        "--commit",
        options.commit,
        "--run-id",
        runId,
        "--config",
        options.configPath,
      ],
      { detached: true, stdio: "inherit" },
    );
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
