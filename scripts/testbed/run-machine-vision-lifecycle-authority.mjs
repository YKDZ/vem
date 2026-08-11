#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const machineRoot = join(repositoryRoot, "apps/machine");
const authorityVitestConfig = fileURLToPath(
  new URL(
    "./machine-vision-lifecycle-authority.vitest.config.ts",
    import.meta.url,
  ),
);
const authoritySpecs = [
  "src/native/vision.spec.ts",
  "src/stores/try-on.spec.ts",
  "src/views/TryOnView.spec.ts",
  "src/try-on/eligibility.spec.ts",
];

export async function runMachineVisionLifecycleAuthority({
  fixture,
  specs,
} = {}) {
  if (fixture && specs) {
    throw new Error("authority accepts either fixture or specs, not both");
  }
  const testTargets = fixture
    ? [
        fileURLToPath(
          new URL(
            `./fixtures/machine-vision-authority-${fixture}.fixture.ts`,
            import.meta.url,
          ),
        ),
      ]
    : [...authoritySpecs, ...(specs ?? [])];
  if (testTargets.length === 0) {
    throw new Error("authority requires at least one expected suite");
  }
  const expectedSuitePaths = testTargets.map(normalizeSuitePath);
  const reportDirectory = mkdtempSync(
    join(tmpdir(), "vem-machine-vision-authority-"),
  );
  const reportPath = join(reportDirectory, "vitest-report.json");
  try {
    const result = await runProcess(
      "pnpm",
      [
        "--filter",
        "machine",
        "exec",
        "vitest",
        "run",
        `--config=${authorityVitestConfig}`,
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
    if (!existsSync(reportPath)) {
      throw new Error(
        `Machine Vision lifecycle authority did not write its JSON report (Vitest exited ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const errors = validateAuthorityReport(report, expectedSuitePaths);
    if (result.exitCode !== 0) {
      errors.push(`Vitest exited ${result.exitCode}`);
    }
    if (errors.length > 0) {
      throw new Error(
        `Machine Vision lifecycle authority rejected the report:\n${errors.join("\n")}`,
      );
    }
    return report;
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function normalizeSuitePath(suitePath) {
  return normalize(resolve(machineRoot, suitePath));
}

function validateAuthorityReport(report, expectedSuitePaths) {
  const errors = [];
  const suiteResults = Array.isArray(report.testResults)
    ? report.testResults
    : [];
  const actualSuitePaths = suiteResults.map((suite) =>
    normalizeSuitePath(suite.name),
  );
  const expectedCounts = countPaths(expectedSuitePaths);
  const actualCounts = countPaths(actualSuitePaths);
  const duplicateExpected = [...expectedCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([suitePath]) => suitePath);
  const missing = [...expectedCounts.keys()].filter(
    (suitePath) => !actualCounts.has(suitePath),
  );
  const unexpected = [...actualCounts.keys()].filter(
    (suitePath) => !expectedCounts.has(suitePath),
  );
  const duplicates = [...actualCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([suitePath]) => suitePath);
  if (
    missing.length ||
    unexpected.length ||
    duplicates.length ||
    duplicateExpected.length
  ) {
    errors.push(
      `suite set mismatch; missing suites: ${formatPaths(missing)}; unexpected suites: ${formatPaths(unexpected)}; duplicate suites: ${formatPaths(duplicates)}; duplicate expected suites: ${formatPaths(duplicateExpected)}`,
    );
  }

  const statuses = suiteResults.flatMap(
    (suite) => suite.assertionResults ?? [],
  );
  const statusCounts = countStatuses(statuses);
  for (const suite of suiteResults) {
    const executed = (suite.assertionResults ?? []).filter(({ status }) =>
      ["passed", "failed"].includes(status),
    );
    if (executed.length === 0) {
      errors.push(
        `suite has no executed tests: ${normalizeSuitePath(suite.name)}`,
      );
    }
  }
  if (report.success !== true) errors.push("report success is not true");
  if (!(report.numTotalTests > 0)) errors.push("report has no tests");
  if (report.numPassedTests !== report.numTotalTests) {
    errors.push(
      `global passed count ${report.numPassedTests} does not equal total ${report.numTotalTests}`,
    );
  }
  for (const status of ["failed", "skipped", "pending", "todo"]) {
    const reportCount = reportCountForStatus(report, status);
    const observed = statusCounts[status] ?? 0;
    if (reportCount > 0 || observed > 0) {
      errors.push(
        `report contains ${status} tests (reported ${reportCount}, observed ${observed})`,
      );
    }
  }
  return errors;
}

function countPaths(paths) {
  return paths.reduce((counts, suitePath) => {
    counts.set(suitePath, (counts.get(suitePath) ?? 0) + 1);
    return counts;
  }, new Map());
}

function countStatuses(assertionResults) {
  return assertionResults.reduce((counts, { status }) => {
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function formatPaths(paths) {
  return paths.length > 0 ? paths.join(", ") : "(none)";
}

function reportCountForStatus(report, status) {
  if (status === "failed") return report.numFailedTests ?? 0;
  if (status === "todo") return report.numTodoTests ?? 0;
  if (status === "pending") return report.numPendingTests ?? 0;
  return report.numSkippedTests ?? 0;
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
  const options = parseArguments(process.argv.slice(2));
  runMachineVisionLifecycleAuthority(options).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

function parseArguments(args) {
  const specs = [];
  let fixture;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if ((argument === "--fixture" || argument === "--spec") && !value) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--fixture") {
      fixture = value;
      index += 1;
    } else if (argument === "--spec") {
      specs.push(value);
      index += 1;
    } else {
      throw new Error(`unknown authority argument: ${argument}`);
    }
  }
  return { fixture, specs: specs.length > 0 ? specs : undefined };
}
