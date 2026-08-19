#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "tsc",
    "-p",
    "tsconfig.testbed.json",
    "--noEmit",
    "--pretty",
    "false",
  ],
  { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname },
);
const combined = `${result.stderr ?? ""}${result.stdout ?? ""}`;
const lines = combined
  .split(/\r?\n/)
  .filter((line) => line.includes("scripts/testbed/framework"));
if (lines.length > 0) {
  process.stderr.write(`framework type errors:\n${lines.join("\n")}\n`);
  process.exitCode = 1;
}
