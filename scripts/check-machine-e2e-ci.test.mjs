import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

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

  it("includes Installed Kiosk Sale Acceptance in the required browser lane", () => {
    const job = checkCiSource.match(
      /async function runMachineE2eJob\(\) \{([\s\S]*?)\n\}/,
    )?.[1];
    assert.ok(job, "machine-e2e job implementation is missing");
    assert.match(job, /"installed-kiosk-sale-acceptance\.spec\.ts"/);
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
    assert.match(machineJob, /needs: changes/);
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

  it("starts independent feedback jobs after change detection rather than Static Checks", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    for (const jobName of [
      "unit-tests",
      "machine-e2e-tests",
      "e2e-tests",
      "admin-contract-e2e-tests",
    ]) {
      const job = workflow.match(
        new RegExp(`${jobName}:([\\s\\S]*?)(?=\\n  [a-z0-9-]+:|$)`),
      )?.[1];
      assert.ok(job, `${jobName} workflow job is missing`);
      assert.match(job, /needs: changes/);
      assert.doesNotMatch(job, /static/);
    }
  });

  it("records queue, run, and cache timing after every CI job completes", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const parsedWorkflow = parse(workflow);
    const parsedTimingJob = parsedWorkflow.jobs["timing-summary"];
    const timingJob = workflow.match(
      /timing-summary:([\s\S]*?)(?=\n  [a-z0-9-]+:|$)/,
    )?.[1];
    assert.ok(timingJob, "CI timing summary job is missing");
    assert.match(timingJob, /name: CI Timing Summary/);
    assert.match(timingJob, /if: always\(\)/);
    assert.match(timingJob, /github\.rest\.actions\.listJobsForWorkflowRun/);
    assert.match(timingJob, /queueMilliseconds/);
    assert.match(timingJob, /runMilliseconds/);
    assert.match(timingJob, /Cache step timing/);
    assert.match(timingJob, /ci-timing-summary\.json/);
    assert.match(timingJob, /actions\/upload-artifact@v4/);
    assert.equal(parsedTimingJob["continue-on-error"], true);
    assert.equal(parsedTimingJob.steps.length, 2);
    assert.ok(
      parsedTimingJob.steps.every((step) => step["continue-on-error"] === true),
      "timing generation and upload must not fail the test workflow",
    );

    const summaryScript = parsedTimingJob.steps[0].with.script;
    assert.match(
      summaryScript,
      /workflowJobs\.filter\(\s*\(job\) => job\.status === "completed"/,
    );
    assert.match(summaryScript, /endMilliseconds < startMilliseconds/);
    assert.match(summaryScript, /return null/);

    for (const jobName of [
      "changes",
      "static",
      "unit-tests",
      "machine-e2e-tests",
      "e2e-tests",
      "admin-contract-e2e-tests",
    ]) {
      assert.match(timingJob, new RegExp(`- ${jobName}`));
    }

    assert.match(workflow, /actions: read/);
    assert.match(workflow, /Setup Node\.js and restore pnpm cache/);
  });

  it("writes a completed timing snapshot without negative durations or itself", async () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const summaryScript = workflow.jobs["timing-summary"].steps[0].with.script;
    const jobs = [
      {
        name: "Skipped Job",
        status: "completed",
        conclusion: "skipped",
        created_at: "2026-07-15T15:44:24Z",
        started_at: "2026-07-15T15:44:26Z",
        completed_at: "2026-07-15T15:44:25Z",
        steps: [
          {
            name: "Restore cache",
            status: "completed",
            conclusion: "skipped",
            started_at: "2026-07-15T15:44:26Z",
            completed_at: "2026-07-15T15:44:25Z",
          },
        ],
      },
      {
        name: "Completed Job",
        status: "completed",
        conclusion: "success",
        created_at: "2026-07-15T15:42:13Z",
        started_at: "2026-07-15T15:42:16Z",
        completed_at: "2026-07-15T15:43:26Z",
        steps: [],
      },
      {
        name: "CI Timing Summary",
        status: "in_progress",
        conclusion: null,
        created_at: "2026-07-15T15:47:10Z",
        started_at: "2026-07-15T15:47:13Z",
        completed_at: null,
        steps: [],
      },
    ];
    const summary = {
      addHeading() {
        return this;
      },
      addRaw() {
        return this;
      },
      addTable() {
        return this;
      },
      async write() {
        return this;
      },
    };
    let writtenSummary;
    const require = (specifier) => {
      assert.equal(specifier, "node:fs");
      return {
        writeFileSync(path, contents) {
          assert.equal(path, "ci-timing-summary.json");
          writtenSummary = contents;
        },
      };
    };
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    const runSummary = new AsyncFunction(
      "github",
      "context",
      "core",
      "require",
      summaryScript,
    );

    await runSummary(
      {
        paginate: async () => jobs,
        rest: { actions: { listJobsForWorkflowRun() {} } },
      },
      { repo: { owner: "YKDZ", repo: "vem" }, runId: 29429239165 },
      { summary },
      require,
    );

    const evidence = JSON.parse(writtenSummary);
    assert.deepEqual(
      evidence.jobs.map(({ name }) => name),
      ["Skipped Job", "Completed Job"],
    );
    assert.equal(evidence.jobs[0].runMilliseconds, null);
    assert.equal(evidence.jobs[0].cacheSteps[0].runMilliseconds, null);
    for (const job of evidence.jobs) {
      for (const milliseconds of [
        job.queueMilliseconds,
        job.runMilliseconds,
        ...job.cacheSteps.map(({ runMilliseconds }) => runMilliseconds),
      ]) {
        assert.ok(milliseconds === null || milliseconds >= 0);
      }
    }
  });
});
