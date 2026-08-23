#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : null;
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} is required`);
  return value;
}

function repeatableOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    values.push(option(args.slice(index), name));
    index += 1;
  }
  return values;
}

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    capture?: boolean;
    allowed?: number[];
  } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (
        code !== null &&
        (code === 0 || options.allowed?.includes(code))
      ) {
        resolvePromise({ code: code ?? -1, stdout });
      } else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

export function parseTriggerOptions(args: string[]): JsonRecord {
  if (args[0] !== "run") {
    throw new Error("usage: runtime-testbed-trigger.ts run --mode ...");
  }
  const mode = option(args, "mode");
  if (!new Set(["fast", "full", "clear_cache"]).has(mode)) {
    throw new Error("--mode must be fast, full, or clear_cache");
  }
  const commit = option(args, "commit").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("--commit must be a full 40-character Git SHA");
  }
  const config = option(args, "config");
  const out = option(args, "out");
  if (!isAbsolute(config) || !isAbsolute(out)) {
    throw new Error("--config and --out must be absolute paths");
  }
  const focus = repeatableOption(args, "focus");
  if (mode !== "fast" && focus.length > 0) {
    throw new Error("--focus is only valid with --mode fast");
  }
  return { mode, focus, commit, config: resolve(config), out: resolve(out) };
}

async function main(): Promise<void> {
  const options = parseTriggerOptions(process.argv.slice(2));
  const hostConfig = JSON.parse(
    await readFile(String(options.config), "utf8"),
  ) as JsonRecord;
  if (hostConfig.schemaVersion !== "vem-runtime-testbed-host/v1") {
    throw new Error("invalid runtime testbed host config");
  }
  const dirty = recordValue(
    await run("git", ["status", "--porcelain"], { capture: true }),
  );
  if (String(dirty.stdout).trim())
    throw new Error("initiating worktree must be clean");
  await run("git", ["cat-file", "-e", `${options.commit}^{commit}`]);
  await run("git", ["init", "--bare", String(hostConfig.mirrorPath)]);
  await run("git", [
    "push",
    "--force",
    String(hostConfig.mirrorPath),
    `${options.commit}:refs/vem/requests/${options.commit}`,
  ]);
  const result = recordValue(
    await run(
    process.execPath,
    [
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url).pathname,
      "run",
      "--mode",
      String(options.mode),
      ...arrayValue(options.focus).flatMap((name) => [
        "--focus",
        String(name),
      ]),
      "--commit",
      String(options.commit),
      "--config",
      String(options.config),
    ],
      { capture: true, allowed: [1, 2, 75] },
    ),
  );
  const line = String(result.stdout).trim().split(/\r?\n/).at(-1);
  if (line === undefined) {
    throw new Error("runtime testbed trigger produced no caller result");
  }
  const callerResult = JSON.parse(line) as JsonRecord;
  await mkdir(dirname(String(options.out)), { recursive: true });
  await writeFile(
    String(options.out),
    `${JSON.stringify(callerResult, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(callerResult)}\n`);
  process.exitCode = Number(result.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async (error) => {
    console.error(`ERROR: ${error.message}`);
    const args = process.argv.slice(2);
    const outIndex = args.indexOf("--out");
    const out = outIndex >= 0 ? args[outIndex + 1] : null;
    if (out && isAbsolute(out)) {
      const compact = join(dirname(out), "vm-runtime-trigger-failure");
      const status = {
        schemaVersion: "vem-runtime-testbed-caller-result/v1",
        runId: null,
        commit: args[args.indexOf("--commit") + 1] ?? null,
        mode: args[args.indexOf("--mode") + 1] ?? null,
        status: "infrastructure_failed",
        error: error.message,
        statusPath: join(compact, "status.json"),
        canonicalCompactArtifactPath: compact,
      };
      await mkdir(compact, { recursive: true });
      await writeFile(
        status.statusPath,
        `${JSON.stringify(status, null, 2)}\n`,
        "utf8",
      );
      await writeFile(out, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    }
    process.exitCode = 2;
  });
}
