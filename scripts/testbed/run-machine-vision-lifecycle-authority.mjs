#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const authoritySpecs = [
  "src/native/vision.spec.ts",
  "src/stores/try-on.spec.ts",
  "src/views/TryOnView.spec.ts",
  "src/try-on/eligibility.spec.ts",
];

export async function runMachineVisionLifecycleAuthority({ fixture } = {}) {
  const reportDirectory = mkdtempSync(
    join(tmpdir(), "vem-machine-vision-authority-"),
  );
  const reportPath = join(reportDirectory, "vitest-report.json");
  const testTargets = fixture
    ? [
        fileURLToPath(
          new URL(
            `./fixtures/machine-vision-authority-${fixture}.fixture.ts`,
            import.meta.url,
          ),
        ),
      ]
    : authoritySpecs;
  try {
    const result = await runProcess(
      "pnpm",
      [
        "--filter",
        "machine",
        "exec",
        "vitest",
        "run",
        "--reporter=json",
        `--outputFile=${reportPath}`,
        ...testTargets,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --conditions=vem-source`.trim(),
        },
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Machine Vision lifecycle authority Vitest exited ${result.exitCode}: ${result.stderr || result.stdout}`,
      );
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.success, true, "authority Vitest report must succeed");
    assert.ok(report.numTotalTests > 0, "authority must execute tests");
    assert.equal(
      report.numPassedTests,
      report.numTotalTests,
      "authority must pass every selected test",
    );
    assert.equal(report.numFailedTests, 0, "authority must not fail tests");
    assert.equal(report.numPendingTests, 0, "authority must not skip tests");
    assert.equal(report.numTodoTests, 0, "authority must not leave TODO tests");
    return report;
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = process.argv[2] === "--fixture" ? process.argv[3] : undefined;
  runMachineVisionLifecycleAuthority({ fixture }).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
