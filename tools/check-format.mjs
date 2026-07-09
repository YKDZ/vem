#!/usr/bin/env node

import { spawn } from "node:child_process";

const FORMAT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code}`,
        ),
      );
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf8"));
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code}`,
        ),
      );
    });
  });
}

function extensionOf(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

async function trackedFormatFiles() {
  const output = await capture("git", ["ls-files", "-z"]);
  return output
    .split("\0")
    .filter(Boolean)
    .filter((path) => FORMAT_EXTENSIONS.has(extensionOf(path)));
}

async function warnAboutUntrackedFiles() {
  const output = await capture("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const untracked = output.split("\n").filter(Boolean);
  if (untracked.length === 0) {
    return;
  }

  console.warn(
    [
      "Note: fmt:check mirrors GitHub CI and only checks tracked files.",
      "Untracked files are not part of a CI checkout until they are added to git.",
      ...untracked.slice(0, 20).map((path) => `  - ${path}`),
      untracked.length > 20
        ? `  ... ${untracked.length - 20} more untracked files`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function main() {
  await warnAboutUntrackedFiles();

  const files = await trackedFormatFiles();
  if (files.length > 0) {
    await run("pnpm", [
      "exec",
      "tsx",
      "node_modules/oxfmt/dist/cli.js",
      ...files,
      "--check",
    ]);
  }

  await run("cargo", ["fmt", "--all", "--", "--check"]);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
