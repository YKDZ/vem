#!/usr/bin/env node

import { spawn } from "node:child_process";

const expectedVersion = "cargo-typify 0.7.0";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
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
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code}${
                message ? `\n${message}` : ""
              }`,
        ),
      );
    });
  });
}

async function cargoTypifyVersion() {
  try {
    return await capture("cargo", ["typify", "--version"]);
  } catch {
    return null;
  }
}

async function main() {
  const actual = await cargoTypifyVersion();
  if (actual === expectedVersion) {
    return;
  }

  console.log(`Installing ${expectedVersion}`);
  await run("cargo", [
    "install",
    "cargo-typify",
    "--version",
    "0.7.0",
    "--locked",
    "--force",
  ]);

  const installed = await cargoTypifyVersion();
  if (installed !== expectedVersion) {
    throw new Error(
      `Expected ${expectedVersion}, but cargo typify reports ${installed ?? "unavailable"}.`,
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
