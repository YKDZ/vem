import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(
  ".github/workflows/vm-runtime-acceptance.yml",
  "utf8",
);

describe("VM runtime acceptance workflow", () => {
  it("has one latest-wins testbed concurrency group across all modes", () => {
    assert.match(workflow, /group: vem-windows-runtime-testbed/);
    assert.match(workflow, /cancel-in-progress: true/);
    assert.match(workflow, /options: \[fast, full, clear_cache\]/);
    assert.match(workflow, /push:\n\s+branches: \[main\]/);
  });

  it("keeps workflow YAML as orchestration and delegates reconstruction to the reusable script", () => {
    assert.match(workflow, /scripts\/testbed\/local-testbed\.mjs reconstruct/);
    assert.match(workflow, /run-local-testbed-guest\.ps1/);
    assert.match(workflow, /VEM_LOCAL_TESTBED_BASELINE_CONTRACT/);
    assert.match(workflow, /VEM_LOCAL_TESTBED_HOST_ADDRESS/);
    assert.match(workflow, /VEM_LOCAL_TESTBED_STATE_ROOT/);
    assert.doesNotMatch(
      workflow,
      /docker run|postgres:|mosquitto|win10-vem-e2e|build-windows-runtime-artifacts|upload-artifact/,
    );
    assert.doesNotMatch(workflow, /2\.22|192\.168\.|118\.25\.|VPS|admin-ui/i);
  });

  it("reconstructs before the persistent Windows runner is scheduled", () => {
    const reconstruct = workflow.indexOf("reconstruct-local-testbed:");
    const windows = workflow.indexOf("run-inside-windows:");
    assert.ok(reconstruct >= 0 && windows > reconstruct);
    assert.match(workflow.slice(windows), /needs: reconstruct-local-testbed/);
    assert.match(
      workflow.slice(windows),
      /runs-on: \[self-hosted, Windows, X64, vem-runtime\]/,
    );
  });
});
