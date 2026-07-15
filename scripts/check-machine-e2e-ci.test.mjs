import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const checkCiSource = readFileSync("tools/check-ci.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

describe("Machine UI daemon E2E CI contract", () => {
  it("builds the Machine workspace dependencies before starting Playwright", () => {
    const job = checkCiSource.match(
      /async function runMachineE2eJob\(\) \{([\s\S]*?)\n\}/,
    )?.[1];
    assert.ok(job, "machine-e2e job implementation is missing");

    const dependencyBuild = job.indexOf(
      'await run("pnpm", ["turbo", "build", "--filter", "machine^..."])',
    );
    const firstPlaywrightRun = job.indexOf('"test:e2e"');
    assert.notEqual(
      dependencyBuild,
      -1,
      "workspace dependency build is missing",
    );
    assert.ok(
      dependencyBuild < firstPlaywrightRun,
      "workspace dependencies must be built before Playwright starts Vite",
    );
  });

  it("runs this clean-workspace contract in the required static gate", () => {
    assert.equal(
      packageJson.scripts["check:machine-e2e-ci"],
      "node --test scripts/check-machine-e2e-ci.test.mjs",
    );
    const staticJob = checkCiSource.match(
      /async function runStaticJob\(\) \{([\s\S]*?)\n\}/,
    )?.[1];
    assert.ok(staticJob, "static job implementation is missing");
    assert.match(staticJob, /await run\("pnpm", \["check:machine-e2e-ci"\]\)/);

    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const machineJob = workflow.match(
      /machine-e2e-tests:([\s\S]*?)(?=\n  [a-z0-9-]+:|$)/,
    )?.[1];
    assert.ok(machineJob, "Machine E2E workflow job is missing");
    assert.match(machineJob, /needs: \[changes, static\]/);
    const install = machineJob.indexOf("pnpm install --frozen-lockfile");
    const runJob = machineJob.indexOf(
      "node tools/check-ci.mjs --job machine-e2e",
    );
    assert.notEqual(install, -1, "clean dependency install is missing");
    assert.ok(
      install < runJob,
      "the one Machine E2E toolchain must run after a clean dependency install",
    );
  });
});
