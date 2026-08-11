import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import YAML from "yaml";

const workflowPath = new URL(
  "../.github/workflows/trusted-release-set-attester.yml",
  import.meta.url,
);

test("trusted release-set attester has a fixed hosted approval boundary", () => {
  const source = readFileSync(workflowPath, "utf8");
  const workflow = YAML.parse(source);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs).sort(), [
    "source_commit",
    "source_ref",
  ]);
  const job = workflow.jobs.approve;
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.deepEqual(job.permissions, {
    actions: "read",
    attestations: "write",
    contents: "read",
    "id-token": "write",
  });
  for (const step of job.steps) {
    if (typeof step.run === "string") assert.doesNotMatch(step.run, /\$\{\{/);
  }
  assert.match(source, /repository: YKDZ\/vem/);
  assert.match(source, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(source, /trusted\/scripts\/release-set-approval\.mjs create/);
  assert.match(source, /actions\/attest-build-provenance@v4/);
  assert.match(
    source,
    /subject-path: trusted-output\/release-set-approval\.json/,
  );
  assert.match(source, /actions\/download-artifact@v4/);
  assert.doesNotMatch(source, /source\/scripts\//);
});
