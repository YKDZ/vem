import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  TrustPolicyError,
  assertNoUntrustedRunExpressions,
  checkReleaseSetTrustPolicy,
} from "./check-release-set-trust-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const trustedCommit = "270dd86853b484ae0db776c8248fc323cacf4ba2";
const workflowPath = new URL(
  "../.github/workflows/trusted-release-set-attester.yml",
  import.meta.url,
);
const callerPath = new URL(
  "../.github/workflows/approve-release-set.yml",
  import.meta.url,
);

function assertNoRunExpressions(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === "string") assert.doesNotMatch(step.run, /\$\{\{/);
    }
  }
}

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
  assertNoRunExpressions(workflow);
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

test("release-set caller pins the immutable attester and cannot inject shell", () => {
  execFileSync("git", ["merge-base", "--is-ancestor", trustedCommit, "HEAD"], {
    cwd: repositoryRoot,
  });
  const trustedBytes = execFileSync(
    "git",
    [
      "show",
      `${trustedCommit}:.github/workflows/trusted-release-set-attester.yml`,
    ],
    { cwd: repositoryRoot },
  );
  assert.deepEqual(readFileSync(workflowPath), trustedBytes);

  const source = readFileSync(callerPath, "utf8");
  const workflow = YAML.parse(source);
  assertNoRunExpressions(workflow);
  const trustedJob = workflow.jobs.trusted_approval;
  assert.equal(trustedJob.needs, "prepare_input");
  assert.equal(
    trustedJob.uses,
    `YKDZ/vem/.github/workflows/trusted-release-set-attester.yml@${trustedCommit}`,
  );
  assert.deepEqual(Object.keys(trustedJob.with).sort(), [
    "source_commit",
    "source_ref",
  ]);
  assert.doesNotMatch(trustedJob.uses, /\$\{\{|refs\/heads|@main|@v[0-9]/);
});

test("trust policy rejects workflow expressions in every YAML run scalar style", () => {
  const scalars = [
    'run: "echo ${{ inputs.source_commit }}"',
    "run: |-\n          echo ${{ inputs.source_commit }}",
    "run: |+\n          echo ${{ inputs.source_commit }}",
    "run: >-\n          echo ${{ inputs.source_commit }}",
    "run: >+\n          echo ${{ inputs.source_commit }}",
  ];
  for (const scalar of scalars) {
    const source = `jobs:\n  mutation:\n    steps:\n      - ${scalar}\n`;
    assert.throws(
      () => assertNoUntrustedRunExpressions(source, "mutation"),
      TrustPolicyError,
    );
  }
  assert.doesNotThrow(() =>
    assertNoUntrustedRunExpressions(
      'jobs:\n  safe:\n    steps:\n      - env:\n          VALUE: ${{ inputs.source_commit }}\n        run: echo "$VALUE"\n',
      "safe",
    ),
  );
});

test("complete release-set trust policy reaches the real gh artifact verifier", () => {
  assert.doesNotThrow(() => checkReleaseSetTrustPolicy(repositoryRoot));
});
