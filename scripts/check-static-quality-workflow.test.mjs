import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const reusable = readFileSync(".github/workflows/static-quality.yml", "utf8");
const checkCi = readFileSync("tools/check-ci.mjs", "utf8");

test("one reusable workflow owns the static quality gate", () => {
  assert.match(reusable, /workflow_call:/);
  assert.match(reusable, /workflow_dispatch:/);
  assert.match(reusable, /node tools\/check-ci\.mjs --job static/);
  assert.match(
    ci,
    /static:[\s\S]*uses: \.\/\.github\/workflows\/static-quality\.yml/,
  );
  assert.doesNotMatch(ci, /node tools\/check-ci\.mjs --job static/);
});

test("the canonical static job includes formatting, types, lint and contracts", () => {
  assert.match(
    checkCi,
    /async function runStaticJob\(\)[\s\S]*pnpm", \["fmt:check"\]/,
  );
  assert.match(
    checkCi,
    /async function runStaticJob\(\)[\s\S]*turbo", "typecheck/,
  );
  assert.match(checkCi, /async function runStaticJob\(\)[\s\S]*turbo", "lint/);
  assert.match(
    checkCi,
    /async function runStaticJob\(\)[\s\S]*check:daemon-ipc-contracts/,
  );
});
