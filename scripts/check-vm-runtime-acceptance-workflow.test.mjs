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
      /Acquire Host Global Lock|Release Host Global Lock/,
    );
    assert.doesNotMatch(
      workflow,
      /docker run|postgres:|mosquitto|win10-vem-e2e|build-windows-runtime-artifacts/,
    );
    assert.doesNotMatch(workflow, /2\.22|192\.168\.|118\.25\.|VPS|admin-ui/i);
  });

  it("always collects bounded fast-sale reports, logs, and screenshots without video", () => {
    const windows = workflow.slice(workflow.indexOf("run-inside-windows:"));
    assert.match(windows, /if: always\(\)/);
    assert.match(windows, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(windows, /fast-route-stress-sale\.json/);
    assert.match(windows, /fast-route-stress-sale-artifacts/);
    assert.match(windows, /retention-days: 7/);
    assert.doesNotMatch(windows, /\.(?:mp4|webm|avi|mov)\b/i);
  });

  it("reconstructs before the persistent Windows runner is scheduled", () => {
    const reconstruct = workflow.indexOf("reconstruct-local-testbed:");
    const windows = workflow.indexOf("run-inside-windows:");
    assert.ok(reconstruct >= 0 && windows > reconstruct);
    assert.doesNotMatch(workflow, /clear-declared-windows-caches:/);
    assert.match(workflow.slice(windows), /needs: reconstruct-local-testbed/);
    assert.match(
      workflow.slice(windows),
      /runs-on: \[self-hosted, Windows, X64, vem-runtime\]/,
    );
  });

  it("runs clear_cache only after reconstructing host state, staging guest input, and admitting the runner", () => {
    assert.match(
      workflow,
      /TESTBED_MODE: \$\{\{ inputs\.mode \|\| 'full' \}\}/,
    );
    assert.match(
      workflow,
      /local-testbed\.mjs reconstruct[\s\S]*--out "\$RUNNER_TEMP\/vem-local-testbed-reconstruction\.json"/,
    );
    assert.match(
      workflow,
      /run-inside-windows:[\s\S]*needs: reconstruct-local-testbed[\s\S]*run-local-testbed-guest\.ps1 -Mode '\$\{\{ needs\.reconstruct-local-testbed\.outputs\.mode \}\}'/,
    );
  });
});
