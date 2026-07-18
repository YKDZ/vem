import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflow = readFileSync(
  ".github/workflows/vm-runtime-acceptance.yml",
  "utf8",
);
const parsedWorkflow = parse(workflow);
const guestRunner = readFileSync(
  "scripts/testbed/run-local-testbed-guest.ps1",
  "utf8",
);
const orchestrator = readFileSync(
  "scripts/testbed/full-workflow-orchestrator.mjs",
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
    assert.match(workflow, /VEM_VM_HOST_LOCK_PATH/);
    assert.equal(
      (workflow.match(/flock "\$VEM_VM_HOST_LOCK_PATH"/g) ?? []).length,
      2,
    );
    assert.equal(
      (
        workflow.match(
          /RUSTUP_TOOLCHAIN: 1\.96\.0-x86_64-unknown-linux-gnu/g,
        ) ?? []
      ).length,
      2,
    );
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

  it("uses the pre-provisioned host Rust toolchain without downloading it per run", () => {
    assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain/);
    assert.match(
      workflow,
      /RUSTUP_TOOLCHAIN: 1\.96\.0-x86_64-unknown-linux-gnu/,
    );
    assert.match(workflow, /Verify cached host Rust toolchain/);
    assert.match(workflow, /rustc 1\.96\.0/);
    assert.match(workflow, /cargo 1\.96\.0/);
  });

  it("uploads only the bounded evidence bundle plus the clear-cache report without forbidden media", () => {
    const windows = workflow.slice(
      workflow.indexOf("run-inside-windows-pass-1:"),
    );
    assert.match(windows, /mode != 'clear_cache'/);
    assert.match(windows, /mode == 'clear_cache'/);
    assert.match(
      windows,
      /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    );
    assert.match(windows, /full-workflow-evidence-bundle/);
    assert.match(windows, /clear-cache-report\.json/);
    assert.match(guestRunner, /foreach \(\$file in @\(\$manifest\.files\)\)/);
    assert.match(guestRunner, /@\("\.json", "\.log", "\.txt", "\.png"\)/);
    assert.match(
      guestRunner,
      /if \(\$Mode -ne "clear_cache"\) \{[\s\S]*New-BoundedEvidenceBundle/,
    );
    for (const artifactRoot of [
      "scanner-payment-code-artifacts",
      "ipc-recovery-artifacts",
      "serial-fulfillment-error-artifacts",
    ]) {
      assert.match(orchestrator, new RegExp(artifactRoot));
    }
    assert.match(windows, /retention-days: 7/);
    assert.doesNotMatch(windows, /\.(?:mp4|webm|avi|mov)\b/i);
    assert.doesNotMatch(
      windows,
      /\.(?:jpg|jpeg|gif|bmp|tiff|wav|bin|qcow2|iso)\b/i,
    );
    assert.doesNotMatch(windows, /\bFactory\b/i);
  });

  it("reconstructs before the persistent Windows runner is scheduled", () => {
    const reconstruct = workflow.indexOf("reconstruct-local-testbed:");
    const windows = workflow.indexOf("run-inside-windows-pass-1:");
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
      /run-inside-windows-pass-1:[\s\S]*needs: reconstruct-local-testbed[\s\S]*run-local-testbed-guest\.ps1 -Mode '\$\{\{ needs\.reconstruct-local-testbed\.outputs\.mode \}\}'/,
    );
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(workflow, /VISION_GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(workflow, /GITHUB_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(
      workflow,
      /Collect Compact Runtime Acceptance Evidence Pass 1\n\s+if: \$\{\{ always\(\) && needs\.reconstruct-local-testbed\.outputs\.mode != 'clear_cache' \}\}/,
    );
    assert.match(
      workflow,
      /Collect Clear Cache Report Pass 1[\s\S]*clear-cache-report\.json/,
    );
  });

  it("runs a second reconstructed full pass and emits a stability gate report for full mode only", () => {
    const pass2Job = parsedWorkflow.jobs["reconstruct-local-testbed-pass-2"];
    const pass2WindowsJob = parsedWorkflow.jobs["run-inside-windows-pass-2"];
    const gate = parsedWorkflow.jobs["full-workflow-stability-gate"];
    assert.match(workflow, /reconstruct-local-testbed-pass-2:/);
    assert.match(workflow, /run-inside-windows-pass-2:/);
    assert.match(workflow, /full-workflow-stability-gate:/);
    assert.deepEqual(pass2Job.needs, [
      "reconstruct-local-testbed",
      "run-inside-windows-pass-1",
    ]);
    assert.match(
      String(pass2Job.if),
      /needs\.reconstruct-local-testbed\.outputs\.mode == 'full' && needs\.run-inside-windows-pass-1\.result == 'success'/,
    );
    assert.deepEqual(pass2WindowsJob.needs, "reconstruct-local-testbed-pass-2");
    assert.match(
      String(pass2WindowsJob.if),
      /needs\.reconstruct-local-testbed-pass-2\.result == 'success'/,
    );
    assert.match(
      String(gate.if),
      /needs\.reconstruct-local-testbed\.outputs\.mode == 'full' && needs\.run-inside-windows-pass-1\.result == 'success' && needs\.run-inside-windows-pass-2\.result == 'success'/,
    );
    assert.match(workflow, /full-workflow-stability-gate\.mjs/);
    assert.match(workflow, /vm-runtime-stability-gate-/);
  });
});
