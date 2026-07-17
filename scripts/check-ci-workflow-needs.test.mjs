import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

function missingNeeds(workflow) {
  const jobs = workflow.jobs ?? {};
  return Object.entries(jobs).flatMap(([jobName, job]) => {
    const needs = Array.isArray(job.needs)
      ? job.needs
      : job.needs
        ? [job.needs]
        : [];
    return needs
      .filter((need) => !(need in jobs))
      .map((need) => `${jobName}.needs references missing job: ${need}`);
  });
}

describe("CI workflow DAG guard", () => {
  it("rejects a needs target that does not declare a workflow job", () => {
    assert.deepEqual(
      missingNeeds({
        jobs: {
          deploy: { needs: ["build", "missing"] },
          build: {},
        },
      }),
      ["deploy.needs references missing job: missing"],
    );
  });

  it("requires every CI needs target to be declared", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    assert.deepEqual(missingNeeds(workflow), []);
  });
});
