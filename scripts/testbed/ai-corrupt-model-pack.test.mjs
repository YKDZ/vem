import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("creates one corrupt private clone without changing the official source", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/testbed/ai-corrupt-model-pack.windows-harness.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.fakeSourceRejected, true);
  assert.equal(output.forgedOfficialRejected, true);
  assert.equal(output.foreignCleanupRejected, true);
  assert.equal(output.foreignPreserved, true);
  assert.equal(output.markerCleanupRejected, true);
  assert.equal(output.tamperedClonePreserved, true);
  assert.equal(output.sourceUnchanged, true);
  assert.equal(output.changedFileCount, 1);
  assert.equal(output.changedByteCount, 1);
  assert.equal(output.changedByteOffset, 0);
  assert.equal(output.changedLength, false);
});
