import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const reusable = readFileSync(".github/workflows/static-quality.yml", "utf8");
const adminBrowser = readFileSync(
  ".github/workflows/admin-browser-acceptance.yml",
  "utf8",
);
const serviceApiVitest = readFileSync(
  "apps/service-api/vitest.config.ts",
  "utf8",
);
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

test("one reusable workflow owns the static quality gate", () => {
  assert.match(reusable, /workflow_call:/);
  assert.match(reusable, /workflow_dispatch:/);
  assert.match(reusable, /pnpm ci:static/);
  assert.match(
    ci,
    /static:[\s\S]*uses: \.\/\.github\/workflows\/static-quality\.yml/,
  );
  assert.doesNotMatch(ci, /tools\/check-ci\.mjs/);
  assert.doesNotMatch(reusable, /tools\/check-ci\.mjs/);
  assert.doesNotMatch(adminBrowser, /tools\/check-ci\.mjs/);
});

test("repository workflows fetch full history for commit-ancestry checks", () => {
  for (const workflowPath of readdirSync(".github/workflows")) {
    if (!/\.ya?ml$/.test(workflowPath)) continue;
    const workflow = readFileSync(`.github/workflows/${workflowPath}`, "utf8");
    const checkouts = workflow.match(
      /uses: actions\/checkout@v\d+[\s\S]*?(?=\n\s*-|\n\S|$)/g,
    );
    if (!checkouts) continue;
    for (const checkout of checkouts) {
      assert.match(
        checkout,
        /fetch-depth: 0/,
        `${workflowPath} checkout must retain commit ancestry`,
      );
    }
  }
});

test("the canonical static job includes formatting, types, lint and contracts", () => {
  const staticCommand = packageJson.scripts["ci:static"];
  const affectedStaticCommand = packageJson.scripts["ci:static:affected"];
  assert.match(staticCommand, /pnpm fmt:check/);
  assert.match(staticCommand, /pnpm typecheck/);
  assert.match(staticCommand, /pnpm lint/);
  assert.match(staticCommand, /pnpm check:daemon-ipc-contracts/);
  assert.match(staticCommand, /pnpm check:vision-v2-contracts/);
  assert.match(affectedStaticCommand, /pnpm check:vision-v2-contracts/);
  assert.match(staticCommand, /pnpm ci:runtime-testbed-contracts/);
});

test("GitHub jobs invoke repository quality entrypoints", () => {
  const workflow = parse(ci);
  assert.equal(workflow.jobs["unit-tests"].steps.at(-1).run, "pnpm ci:unit");
  assert.equal(
    workflow.jobs["service-api-e2e"].steps.at(-1).run,
    "pnpm ci:service-api-e2e",
  );
  assert.equal(
    workflow.jobs["backend-deployment-contracts"].steps.at(-1).run,
    "pnpm ci:backend-deployment",
  );
  assert.equal(workflow.jobs["rust-tests"].steps.at(-1).run, "pnpm ci:rust");
  assert.match(adminBrowser, /pnpm ci:admin-browser/);
});

test("Service API flow e2e is separated from the unit test entrypoint", () => {
  const serviceE2eCommand = packageJson.scripts["ci:service-api-e2e"];
  assert.match(serviceE2eCommand, /pnpm turbo build/);
  assert.match(serviceE2eCommand, /--filter @vem\/shared/);
  assert.match(serviceE2eCommand, /--filter @vem\/db/);
  assert.match(serviceE2eCommand, /--output-logs=errors-only/);
  assert.match(serviceE2eCommand, /pnpm --filter service-api test:e2e/);
  assert.match(serviceApiVitest, /\*\*\/\*\.e2e-spec\.ts/);
  assert.match(serviceApiVitest, /\*\*\/\*\.postgres\.integration\.spec\.ts/);
});
