import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflow = readFileSync(
  ".github/workflows/vm-runtime-acceptance.yml",
  "utf8",
);
const parsedWorkflow = parse(workflow);

describe("VM runtime acceptance workflow", () => {
  it("preserves entry triggers and adds reusable workflow_call mode", () => {
    assert.match(workflow, /push:\n\s+branches: \[main\]/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /workflow_call:/);
    assert.match(workflow, /workflow_call:\n\s+inputs:\n\s+mode:/);
    assert.match(workflow, /type: string/);
    assert.match(workflow, /options: \[fast, full, clear_cache\]/);
  });

  it("uses one Linux self-hosted thin caller job", () => {
    assert.equal(Object.keys(parsedWorkflow.jobs).length, 1);
    assert.match(
      workflow,
      /invoke-runtime-testbed-caller:\n\s+name: Invoke Runtime Testbed Caller/,
    );
    assert.match(workflow, /runs-on: \[self-hosted, Linux, X64, vem-runtime\]/);
    assert.match(workflow, /group: vem-windows-runtime-testbed/);
    assert.match(workflow, /cancel-in-progress: true/);
  });

  it("calls the shared runtime-testbed-trigger CLI with contract arguments", () => {
    assert.match(
      workflow,
      /scripts\/testbed\/runtime-testbed-trigger\.mjs run/,
    );
    assert.match(workflow, /--mode "\$TESTBED_MODE"/);
    assert.match(workflow, /--commit "\$GITHUB_SHA"/);
    assert.match(workflow, /--config "\$VEM_TESTBED_HOST_CONFIG"/);
    assert.match(
      workflow,
      /--out "\$RUNNER_TEMP\/vm-runtime-acceptance-caller-result\.json"/,
    );
    assert.match(
      workflow,
      /TESTBED_MODE: \$\{\{ inputs\.mode \|\| 'full' \}\}/,
    );
    assert.match(workflow, /\$\{\{ vars\.VEM_TESTBED_HOST_CONFIG \}\}/);
  });

  it("writes and uploads caller-result canonical artifact path", () => {
    assert.match(workflow, /id: caller/);
    assert.match(workflow, /readFile\(resultPath, "utf8"\)/);
    assert.match(workflow, /canonicalCompactArtifact(?:Path)?/);
    assert.match(
      workflow,
      /process\.env\.GITHUB_OUTPUT,\s*`artifact_path=\$\{artifactPath\}\\n`/s,
    );
    assert.match(workflow, /steps\.caller\.outputs\.artifact_path/);
    assert.match(workflow, /Upload canonical compact artifact/);
    assert.match(workflow, /Apply canonical result/);
    assert.match(workflow, /superseded\)/);
    assert.match(workflow, /actions\/runs\/\$GITHUB_RUN_ID\/cancel/);
  });

  it("removes windows runner token, windows jobs, and workflow-owned sequencing/gate", () => {
    assert.doesNotMatch(
      workflow,
      /VEM_RUNNER_ADMIN_TOKEN|runner_token|runs-on: \[self-hosted, Windows/i,
    );
    assert.doesNotMatch(
      workflow,
      /reconstruct-local-testbed|pass-1|pass-2|stability-gate|win10-vem-e2e|local-testbed\.mjs reconstruct/,
    );
  });

  it("uses repository vars for host config and avoids hardcoded legacy host constants", () => {
    assert.match(
      workflow,
      /VEM_TESTBED_HOST_CONFIG: \$\{\{ vars\.VEM_TESTBED_HOST_CONFIG \}\}/,
    );
    assert.doesNotMatch(workflow, /2\.22|192\.168\.|118\.25\./);
  });
});
