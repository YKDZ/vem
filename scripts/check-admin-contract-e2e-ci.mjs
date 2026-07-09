#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function readRequiredText(root, path, failures) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (error) {
    failures.push(`missing required file: ${path} (${error.message})`);
    return "";
  }
}

function fileExists(root, path) {
  try {
    return statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}

function extractJobBlock(workflow, jobName) {
  const jobHeader = new RegExp(`^  ${jobName}:\\n`, "m");
  const match = jobHeader.exec(workflow);
  if (!match) {
    return null;
  }
  const start = match.index;
  const rest = workflow.slice(start + match[0].length);
  const nextJob = /^  [A-Za-z0-9_-]+:\n/m.exec(rest);
  return workflow.slice(
    start,
    nextJob ? start + match[0].length + nextJob.index : undefined,
  );
}

function requireIncludes(text, label, required, failures) {
  for (const value of required) {
    if (!text.includes(value)) {
      failures.push(`${label} should include ${value}`);
    }
  }
}

function readAdminUiScripts(root, failures) {
  const path = "apps/admin-ui/package.json";
  if (!fileExists(root, path)) {
    failures.push(`missing required file: ${path}`);
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(join(root, path), "utf8"));
    return parsed.scripts ?? {};
  } catch (error) {
    failures.push(`${path} should be valid JSON: ${error.message}`);
    return {};
  }
}

export function checkAdminContractE2eCi(options = {}) {
  const root = options.root ?? process.cwd();
  const failures = [];
  const workflow = readRequiredText(root, ".github/workflows/ci.yml", failures);
  const runner = readRequiredText(root, "tools/check-ci.mjs", failures);
  const job = extractJobBlock(workflow, "admin-contract-e2e-tests");

  if (!job) {
    failures.push("missing dedicated admin-contract-e2e-tests job");
  } else {
    requireIncludes(
      job,
      "admin-contract-e2e-tests job",
      [
        "Admin Contract E2E",
        "Production readiness",
        "node tools/check-ci.mjs --job admin-contract-e2e",
        "apps/admin-ui/test-results/",
        "if-no-files-found: warn",
        "admin-contract-service-api.log",
        "admin-contract-admin-ui.log",
      ],
      failures,
    );
    if (job.includes("run: pnpm test:e2e\n")) {
      failures.push(
        "admin-contract-e2e-tests job should run pnpm test:e2e:admin-contract, not the broad pnpm test:e2e suite",
      );
    }
    if (job.includes("--job admin-e2e")) {
      failures.push(
        "admin-contract-e2e-tests job should run the dedicated admin-contract-e2e runner job, not admin-e2e",
      );
    }
  }

  requireIncludes(
    runner,
    "shared CI runner",
    [
      "admin-contract-e2e",
      "postgres:16",
      "vem_admin_contract_e2e",
      "eclipse-mosquitto:2",
      "mosquitto-admin-contract",
      '"turbo", "build", "--filter", "service-api"',
      '"--filter", "@vem/db", "migrate"',
      '"node", ["dist/main.js"]',
      "MQTT_URL",
      '"pnpm", ["dev", "--", "--strictPort"]',
      "test:e2e:admin-contract",
      "admin-contract-service-api.log",
      "admin-contract-admin-ui.log",
    ],
    failures,
  );

  const scripts = readAdminUiScripts(root, failures);
  const command = scripts["test:e2e:admin-contract"];
  if (!command) {
    failures.push("admin-ui missing test:e2e:admin-contract package script");
  } else {
    requireIncludes(
      command,
      "admin-ui test:e2e:admin-contract",
      [
        "playwright test",
        "tests/product-catalog-admin-contract.spec.ts",
        "tests/payment-operations-admin-contract.spec.ts",
        "tests/access-management-insufficient-permission.spec.ts",
      ],
      failures,
    );
  }

  return { ok: failures.length === 0, failures };
}

function printResult(result) {
  if (result.ok) {
    console.log("ok - admin contract e2e ci job is configured");
    return;
  }
  for (const failure of result.failures) {
    console.error(`not ok - ${failure}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlagIndex = process.argv.indexOf("--root");
  const root =
    rootFlagIndex === -1 ? process.cwd() : process.argv[rootFlagIndex + 1];
  const result = checkAdminContractE2eCi({ root });
  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}
